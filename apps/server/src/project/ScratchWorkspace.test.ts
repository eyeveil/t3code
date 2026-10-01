import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as ScratchWorkspace from "./ScratchWorkspace.ts";

// Real repository detection: the service only asks the Git workflow whether
// the data dir is inside a checkout.
const gitWorkflowLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
    return Layer.mock(GitWorkflow.GitWorkflowService)({
      isRepository: (cwd) =>
        registry.detect({ cwd }).pipe(
          Effect.map((handle) => handle?.kind === "git"),
          Effect.orDie,
        ),
    });
  }),
).pipe(Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))));

const enrichmentLayer = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

/** The service over a real ProjectService, with its data dir at `baseDir`. */
const makeLayer = (baseDir: string) =>
  ScratchWorkspace.layer.pipe(
    Layer.provideMerge(ProjectServiceLayerLive),
    Layer.provideMerge(enrichmentLayer),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(gitWorkflowLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

/** Runs `body` with a data dir in a fresh temp folder, outside any checkout. */
const withScratch = <A, E>(
  body: (input: {
    readonly baseDir: string;
  }) => Effect.Effect<
    A,
    E,
    | ScratchWorkspace.ScratchWorkspace
    | ProjectService.ProjectService
    | FileSystem.FileSystem
    | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scratch-" });
    return yield* body({ baseDir }).pipe(Effect.provide(makeLayer(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const git = (cwd: string, args: ReadonlyArray<string>) =>
  ProcessRunner.ProcessRunner.pipe(
    Effect.flatMap((runner) => runner.run({ command: "git", args: ["-C", cwd, ...args] })),
    Effect.provide(ProcessRunner.layer),
  );

const requireRoot = Effect.gen(function* () {
  const scratch = yield* ScratchWorkspace.ScratchWorkspace;
  return Option.getOrThrow(yield* scratch.root);
});

it.effect("offers a Scratch folder under the data dir when it is outside a checkout", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(yield* requireRoot, path.resolve(baseDir, "scratch"));
    }),
  ),
);

it.effect("offers nothing when the data dir sits inside a Git checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scratch-repo-" });
    yield* git(checkout, ["init", "--quiet"]);
    const baseDir = path.join(checkout, ".t3");
    yield* fileSystem.makeDirectory(baseDir);
    yield* Effect.gen(function* () {
      const scratch = yield* ScratchWorkspace.ScratchWorkspace;
      assert.isTrue(Option.isNone(yield* scratch.root));
      const failure = yield* Effect.flip(scratch.ensureProject);
      assert.equal(failure._tag, "ScratchWorkspaceUnavailableError");
    }).pipe(Effect.provide(makeLayer(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("creates one Scratch project, even for concurrent first requests", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ScratchWorkspace.ScratchWorkspace;
      const projects = yield* ProjectService.ProjectService;
      // Without handling the losing creates' conflicts, eight racers fail.
      const racers = yield* Effect.all(
        Array.from({ length: 8 }, () => scratch.ensureProject),
        { concurrency: "unbounded" },
      );
      const again = yield* scratch.ensureProject;
      assert.deepEqual(
        new Set(racers.map((result) => result.projectId)),
        new Set([again.projectId]),
      );

      const snapshot = yield* projects.snapshot;
      const root = yield* requireRoot;
      const scratchProjects = snapshot.projects.filter((project) => project.workspaceRoot === root);
      assert.lengthOf(scratchProjects, 1);
      assert.equal(scratchProjects[0]?.title, "No project");
      assert.deepEqual(scratchProjects[0]?.projectIcon, {
        kind: "lucide",
        name: "message-square-dashed",
        color: "gray",
      });
    }),
  ),
);

it.effect("recreates the Scratch folder after it is deleted", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ScratchWorkspace.ScratchWorkspace;
      const fileSystem = yield* FileSystem.FileSystem;
      const { projectId } = yield* scratch.ensureProject;
      const root = yield* requireRoot;
      yield* fileSystem.remove(root, { recursive: true });

      assert.equal((yield* scratch.ensureProject).projectId, projectId);
      assert.isTrue(yield* fileSystem.exists(root));

      yield* fileSystem.remove(root, { recursive: true });
      const folder = yield* scratch.folderForThread({
        projectId,
        threadId: ThreadId.make("thread-after-delete"),
        text: "Still works",
      });
      assert.isTrue(yield* fileSystem.exists(Option.getOrThrow(folder)));
    }),
  ),
);

it.effect("gives each Scratch thread its own folder, named from its message", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ScratchWorkspace.ScratchWorkspace;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { projectId } = yield* scratch.ensureProject;
      const root = yield* requireRoot;
      const text = "Convert these PNGs to WebP, please!";
      // Two ids with the same tail would collide on the short name.
      const first = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:a:0123456789abcdef"),
          text,
        }),
      );
      const second = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:b:0123456789abcdef"),
          text,
        }),
      );

      // Ids that normalize to the same characters take both of its names.
      const third = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:b0123456789abcdef"),
          text,
        }),
      );

      assert.equal(new Set([first, second, third]).size, 3);
      for (const folder of [first, second, third]) {
        assert.equal(path.dirname(folder), root);
        assert.match(path.basename(folder), /^\d{4}-\d{2}-\d{2}-convert-these-pngs-to-webp-/);
        assert.isTrue(yield* fileSystem.exists(folder));
      }

      const pasted = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread-pasted"),
          text: `${"word ".repeat(10_000)}../../etc`,
        }),
      );
      assert.equal(path.dirname(pasted), root);
      assert.isAtMost(path.basename(pasted).length, 80);
    }),
  ),
);

it.effect("leaves threads in other projects alone", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const scratch = yield* ScratchWorkspace.ScratchWorkspace;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* scratch.ensureProject;
      const other = yield* projects.create({
        commandId: CommandId.make("command:other"),
        projectId: ProjectId.make("project:other"),
        title: "Other",
        workspaceRoot: path.join(baseDir, "other"),
        createWorkspaceRootIfMissing: true,
      });

      const folder = yield* scratch.folderForThread({
        projectId: other.id,
        threadId: ThreadId.make("thread-other"),
        text: "Hello",
      });
      assert.isTrue(Option.isNone(folder));
      assert.deepEqual(yield* fileSystem.readDirectory(yield* requireRoot), []);
    }),
  ),
);
