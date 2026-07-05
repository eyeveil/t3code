import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeProjectDirectoryName,
  ensureClaudeSessionTranscriptForCwd,
} from "./ClaudeSessionTranscripts.ts";

const SESSION_ID = "742df3e5-534e-48da-abed-8646dfe8312e";

const makeFixture = Effect.fn("makeFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-transcripts-" });
  const projectsDir = path.join(home, ".claude", "projects");
  const oldCwd = path.join(home, "old-workspace");
  const newCwd = path.join(home, "new-workspace");
  const oldProjectDir = path.join(projectsDir, claudeProjectDirectoryName(oldCwd));
  const newProjectDir = path.join(projectsDir, claudeProjectDirectoryName(newCwd));
  yield* fileSystem.makeDirectory(oldProjectDir, { recursive: true });
  yield* fileSystem.writeFileString(path.join(oldProjectDir, `${SESSION_ID}.jsonl`), "{}\n");
  return { fileSystem, path, home, oldCwd, newCwd, oldProjectDir, newProjectDir };
});

it.layer(NodeServices.layer)("ClaudeSessionTranscripts", (it) => {
  describe("claudeProjectDirectoryName", () => {
    it.effect("replaces every non-alphanumeric character with a dash", () =>
      Effect.gen(function* () {
        expect(claudeProjectDirectoryName("/home/nyx/dev/t3code")).toBe("-home-nyx-dev-t3code");
        expect(claudeProjectDirectoryName("/home/nyx/CROZ/Jarvis/llm-proxy")).toBe(
          "-home-nyx-CROZ-Jarvis-llm-proxy",
        );
      }),
    );
  });

  describe("ensureClaudeSessionTranscriptForCwd", () => {
    it.effect("copies the transcript into the project directory for a new cwd", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const migration = yield* ensureClaudeSessionTranscriptForCwd({
          claudeSettings: { homePath: fixture.home },
          sessionId: SESSION_ID,
          cwd: fixture.newCwd,
        });
        expect(migration).toEqual({
          outcome: "migrated",
          fromProjectDir: claudeProjectDirectoryName(fixture.oldCwd),
          toProjectDir: claudeProjectDirectoryName(fixture.newCwd),
        });
        expect(
          yield* fixture.fileSystem.exists(
            fixture.path.join(fixture.newProjectDir, `${SESSION_ID}.jsonl`),
          ),
        ).toBe(true);
      }),
    );

    it.effect("copies the subagent sidecar directory alongside the transcript", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const sidecar = fixture.path.join(fixture.oldProjectDir, SESSION_ID, "subagents");
        yield* fixture.fileSystem.makeDirectory(sidecar, { recursive: true });
        yield* fixture.fileSystem.writeFileString(
          fixture.path.join(sidecar, "agent-1.jsonl"),
          "{}\n",
        );
        yield* ensureClaudeSessionTranscriptForCwd({
          claudeSettings: { homePath: fixture.home },
          sessionId: SESSION_ID,
          cwd: fixture.newCwd,
        });
        expect(
          yield* fixture.fileSystem.exists(
            fixture.path.join(fixture.newProjectDir, SESSION_ID, "subagents", "agent-1.jsonl"),
          ),
        ).toBe(true);
      }),
    );

    it.effect("reports a transcript already reachable from the cwd", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const migration = yield* ensureClaudeSessionTranscriptForCwd({
          claudeSettings: { homePath: fixture.home },
          sessionId: SESSION_ID,
          cwd: fixture.oldCwd,
        });
        expect(migration).toEqual({ outcome: "already-present" });
      }),
    );

    it.effect("reports a session that exists in no project directory", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const migration = yield* ensureClaudeSessionTranscriptForCwd({
          claudeSettings: { homePath: fixture.home },
          sessionId: "00000000-0000-0000-0000-000000000000",
          cwd: fixture.newCwd,
        });
        expect(migration).toEqual({ outcome: "not-found" });
      }),
    );
  });
});
