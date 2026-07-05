import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { resolveClaudeHomePath } from "./ClaudeHome.ts";

// Claude Code keeps one transcript directory per working directory:
// <home>/.claude/projects/<munged-cwd>/<sessionId>.jsonl. `--resume` only
// searches the directory derived from the spawn cwd, so a session that last
// ran under a different cwd (e.g. a thread moved to another project) is
// invisible there and the CLI fails with "No conversation found with
// session ID".
export const claudeProjectDirectoryName = (cwd: string): string =>
  cwd.replace(/[^a-zA-Z0-9]/g, "-");

export type ClaudeTranscriptMigration =
  | { readonly outcome: "already-present" }
  | {
      readonly outcome: "migrated";
      readonly fromProjectDir: string;
      readonly toProjectDir: string;
    }
  | { readonly outcome: "not-found" };

export const ensureClaudeSessionTranscriptForCwd = Effect.fn("ensureClaudeSessionTranscriptForCwd")(
  function* (input: {
    readonly claudeSettings: Pick<ClaudeSettings, "homePath">;
    readonly sessionId: string;
    readonly cwd: string;
  }): Effect.fn.Return<
    ClaudeTranscriptMigration,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homePath = yield* resolveClaudeHomePath(input.claudeSettings);
    const projectsDir = path.join(homePath, ".claude", "projects");
    const transcriptName = `${input.sessionId}.jsonl`;
    const targetDirName = claudeProjectDirectoryName(path.resolve(input.cwd));
    const targetDir = path.join(projectsDir, targetDirName);

    if (yield* fileSystem.exists(path.join(targetDir, transcriptName))) {
      return { outcome: "already-present" };
    }
    if (!(yield* fileSystem.exists(projectsDir))) {
      return { outcome: "not-found" };
    }

    const entries = yield* fileSystem.readDirectory(projectsDir);
    for (const entry of entries) {
      if (entry === targetDirName) continue;
      const sourceDir = path.join(projectsDir, entry);
      const sourceTranscript = path.join(sourceDir, transcriptName);
      if (!(yield* fileSystem.exists(sourceTranscript))) continue;

      yield* fileSystem.makeDirectory(targetDir, { recursive: true });
      yield* fileSystem.copyFile(sourceTranscript, path.join(targetDir, transcriptName));
      // Sidecar directory holds subagent transcripts for the session.
      const sourceSidecar = path.join(sourceDir, input.sessionId);
      if (yield* fileSystem.exists(sourceSidecar)) {
        yield* fileSystem.copy(sourceSidecar, path.join(targetDir, input.sessionId));
      }
      return { outcome: "migrated", fromProjectDir: entry, toProjectDir: targetDirName };
    }

    return { outcome: "not-found" };
  },
);
