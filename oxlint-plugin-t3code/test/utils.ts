import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Formatter, Path, Stream, Predicate } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

class OxlintFixtureFailure extends Data.TaggedError("OxlintFixtureFailure")<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  static readonly is = (u: unknown): u is OxlintFixtureFailure =>
    Predicate.isTagged(u, "OxlintFixtureFailure");
}

class OxlintFixtureExpectedFailure extends Data.TaggedError("OxlintFixtureExpectedFailure")<{
  readonly ruleName: string;
}> {
  override get message() {
    return `Expected oxlint to report a failure for rule ${this.ruleName}, but it passed.`;
  }
}

type HarnessEffect<A> = Effect.Effect<A, unknown, NodeServices.NodeServices>;
type InvalidAssertion = (output: string) => void;

type RuleHarness = {
  readonly run: (source: string) => HarnessEffect<string>;
  readonly runAndExpectFailure: (source: string) => HarnessEffect<string>;
  readonly valid: (name: string, source: string) => void;
  readonly invalid: (name: string, source: string, assertion?: InvalidAssertion) => void;
};

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const spawnAndCollectOutput = Effect.fnUntraced(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { exitCode, stdout, stderr };
}, Effect.scoped);

export const createOxlintRuleHarness = (ruleName: string): RuleHarness => {
  const [pluginName, shortRuleName] = ruleName.split("/");
  const diagnosticRuleName =
    pluginName && shortRuleName ? `${pluginName}\\(${shortRuleName}\\)` : ruleName;
  const test = it.layer(NodeServices.layer);

  const run = Effect.fnUntraced(function* (source: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtureDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-oxlint-" });
    const configPath = path.join(fixtureDir, ".oxlintrc.json");
    const sourcePath = path.join(fixtureDir, "fixture.ts");
    const repoRoot = path.join(import.meta.dirname, "..", "..");
    const oxlintBin = path.join(repoRoot, "node_modules", ".bin", "oxlint");
    const pluginPath = path.join(repoRoot, "oxlint-plugin-t3code", "index.ts");

    yield* fs.writeFileString(
      configPath,
      Formatter.formatJson({
        jsPlugins: [{ name: "t3code", specifier: pluginPath }],
        rules: { [ruleName]: "error" },
      }),
    );
    yield* fs.writeFileString(sourcePath, source);

    const output = yield* spawnAndCollectOutput(
      ChildProcess.make(oxlintBin, ["--config", configPath, sourcePath], { cwd: repoRoot }),
    );

    if (output.exitCode !== 0) {
      return yield* new OxlintFixtureFailure({
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
      });
    }

    return `${output.stdout}${output.stderr}`;
  }, Effect.scoped);

  const runAndExpectFailure = (source: string): HarnessEffect<string> =>
    run(source).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          OxlintFixtureFailure.is(error)
            ? Effect.succeed(
                `oxlint fixture failed with exit code ${error.exitCode}\n${error.stdout}\n${error.stderr}`,
              )
            : Effect.fail(error),
        onSuccess: () => Effect.fail(new OxlintFixtureExpectedFailure({ ruleName })),
      }),
    );

  return {
    run,
    runAndExpectFailure,
    valid(name, source) {
      test(name, (it) => {
        it.effect("passes", () => run(source).pipe(Effect.asVoid));
      });
    },
    invalid(name, source, assertion) {
      test(name, (it) => {
        it.effect("reports the rule diagnostic", () =>
          Effect.gen(function* () {
            const output = yield* runAndExpectFailure(source);
            assert.match(output, new RegExp(diagnosticRuleName));
            assertion?.(output);
          }),
        );
      });
    },
  };
};
