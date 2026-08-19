import { expect, it } from "@effect/vitest";

import { CodexMaintenanceResolver } from "./CodexDriver.ts";

it("uses Codex's native updater for standalone installations", () => {
  expect(
    CodexMaintenanceResolver.resolve({
      binaryPath: "codex",
      resolvedCommandPath: "/Users/example/.local/bin/codex",
      realCommandPath:
        "/Users/example/.codex/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex",
    }),
  ).toEqual({
    provider: "codex",
    packageName: "@openai/codex",
    update: {
      command: "codex update",
      executable: "codex",
      args: ["update"],
      lockKey: "codex-native",
    },
  });
});
