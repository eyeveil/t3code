import { CommandId, ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "./ProjectService.ts";

export class ScratchWorkspaceUnavailableError extends Schema.TaggedError<ScratchWorkspaceUnavailableError>()(
  "ScratchWorkspaceUnavailableError",
  {},
) {
  override get message(): string {
    return "Threads without a project are not available on this environment.";
  }
}

export class ScratchWorkspaceFolderError extends Schema.TaggedError<ScratchWorkspaceFolderError>()(
  "ScratchWorkspaceFolderError",
  {
    folder: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the folder for threads without a project.";
  }
}

export class ScratchWorkspaceProjectError extends Schema.TaggedError<ScratchWorkspaceProjectError>()(
  "ScratchWorkspaceProjectError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project for threads without a project.";
  }
}

export type ScratchWorkspaceError =
  | ScratchWorkspaceUnavailableError
  | ScratchWorkspaceFolderError
  | ScratchWorkspaceProjectError;

/**
 * Threads without a project. They live in the environment's Scratch project
 * ("No project"), a plain folder under the data dir, and each thread gets a
 * subfolder of its own so threads never share files.
 */
export class ScratchWorkspace extends Context.Service<
  ScratchWorkspace,
  {
    /** The Scratch folder, or None when this environment does not offer one. */
    readonly root: Effect.Effect<Option.Option<string>>;
    /** Finds or creates the Scratch project and (re)creates its folder. */
    readonly ensureProject: Effect.Effect<{ readonly projectId: ProjectId }, ScratchWorkspaceError>;
    /**
     * Claims a fresh folder for a new thread in the Scratch project, named from
     * the date, its first message, and its id. None for every other project.
     */
    readonly folderForThread: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<Option.Option<string>, ScratchWorkspaceFolderError>;
  }
>()("t3/project/ScratchWorkspace") {}

// Only [a-z0-9] reaches a folder name, so it stays one path segment, and the
// words are capped so a pasted blob cannot outgrow a file name.
const folderWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitWorkflow.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;

  // Inside a checkout (a dev worktree's .t3, a dotfiles home) the folder would
  // inherit the repo's git status and checkpoints, so Scratch is offered only
  // when the data dir is outside any work tree. Probed once; detection
  // failures hide Scratch rather than failing callers. An interrupted probe
  // invalidates the cache so the next caller probes again.
  const [probe, invalidate] = yield* Effect.cachedInvalidateWithTTL(
    git.isRepository(config.baseDir).pipe(
      Effect.map((isRepository) =>
        isRepository ? Option.none<string>() : Option.some(path.resolve(config.baseDir, "scratch")),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Option.none<string>()),
      ),
    ),
    Duration.infinity,
  );
  const root = probe.pipe(Effect.onInterrupt(() => invalidate));

  const makeFolder = (folder: string, options?: { readonly recursive?: boolean }) =>
    fileSystem
      .makeDirectory(folder, options)
      .pipe(Effect.mapError((cause) => new ScratchWorkspaceFolderError({ folder, cause })));

  const ensureProject: ScratchWorkspace["Service"]["ensureProject"] = Effect.gen(function* () {
    const workspaceRoot = yield* root.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ScratchWorkspaceUnavailableError()),
          onSome: Effect.succeed,
        }),
      ),
    );
    // Re-made on every call, so a deleted Scratch folder still runs threads.
    yield* makeFolder(workspaceRoot, { recursive: true });
    const id = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => new ScratchWorkspaceProjectError({ workspaceRoot, cause })),
    );
    const bootstrapped = yield* projects
      .bootstrap({
        commandId: CommandId.make(`scratch-project:${id}`),
        projectId: ProjectId.make(id),
        title: "No project",
        workspaceRoot,
      })
      .pipe(
        // bootstrap looks the root up before taking the workspace lock, so a
        // racing create loses with a conflict that names the winner.
        Effect.catchTags({
          ProjectConflictError: (conflict) =>
            Effect.succeed({
              project: { id: conflict.conflictingProjectId },
              created: false,
            }),
        }),
        Effect.mapError((cause) => new ScratchWorkspaceProjectError({ workspaceRoot, cause })),
      );
    if (bootstrapped.created) {
      // A dashed chat bubble in neutral gray marks Scratch. Set once at
      // create, so a user's own icon choice is never overwritten.
      yield* projects
        .update({
          commandId: CommandId.make(`scratch-project-icon:${id}`),
          projectId: bootstrapped.project.id,
          projectIcon: { kind: "lucide", name: "message-square-dashed", color: "gray" },
        })
        .pipe(
          Effect.mapError((cause) => new ScratchWorkspaceProjectError({ workspaceRoot, cause })),
        );
    }
    return { projectId: bootstrapped.project.id };
  });

  const isScratchProject = (projectId: ProjectId, scratchRoot: string) =>
    projects.getById(projectId).pipe(
      Effect.map(
        Option.exists(
          (project) => path.resolve(project.workspaceRoot) === path.resolve(scratchRoot),
        ),
      ),
      // An unreadable project is not Scratch; the launch reports its own
      // project lookup failure.
      Effect.orElseSucceed(() => false),
    );

  const folderForThread: ScratchWorkspace["Service"]["folderForThread"] = Effect.fn(
    "ScratchWorkspace.folderForThread",
  )(function* (input) {
    const scratchRoot = yield* root;
    if (Option.isNone(scratchRoot)) return Option.none();
    if (!(yield* isScratchProject(input.projectId, scratchRoot.value))) return Option.none();
    const date = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
    const words = folderWords(input.text);
    const id = input.threadId.toLowerCase().replace(/[^a-z0-9]/g, "");
    const folderFor = (idPart: string) =>
      path.join(scratchRoot.value, [date, words, idPart].filter(Boolean).join("-"));
    yield* makeFolder(scratchRoot.value, { recursive: true });
    // Each leaf is created without `recursive`, so creating it claims it. A
    // taken short name falls back to the full id, which only this thread holds.
    const claim = (folder: string) =>
      fileSystem.makeDirectory(folder).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError((cause) => new ScratchWorkspaceFolderError({ folder, cause })),
      );
    // Thread ids often share a prefix ("thread:..."), so the short name uses
    // the id's tail.
    const shortFolder = folderFor(id.slice(-8));
    if (yield* claim(shortFolder)) return Option.some(shortFolder);
    const fullFolder = folderFor(id);
    if (yield* claim(fullFolder)) return Option.some(fullFolder);
    // Ids that normalize alike, or a launch retried without its receipt, can
    // find the full name taken too. A folder is never shared, so claim a fresh
    // suffixed one instead.
    while (true) {
      const suffix = (yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new ScratchWorkspaceFolderError({ folder: fullFolder, cause })),
      )).slice(0, 8);
      const folder = `${fullFolder}-${suffix}`;
      if (yield* claim(folder)) return Option.some(folder);
    }
  });

  return ScratchWorkspace.of({ root, ensureProject, folderForThread });
});

export const layer = Layer.effect(ScratchWorkspace, make);
