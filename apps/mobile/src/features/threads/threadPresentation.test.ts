import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadStatus } from "./threadPresentation";

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Test thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    lastActivitySummary: null,
    lastActivityAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

function runningTurn(): EnvironmentThreadShell["latestTurn"] {
  return {
    turnId: TurnId.make("turn-1"),
    state: "running",
    requestedAt: "2026-06-01T00:00:00.000Z",
    startedAt: "2026-06-01T00:00:01.000Z",
    completedAt: null,
    assistantMessageId: null,
  };
}

describe("resolveThreadStatus", () => {
  it("marks a running session as working", () => {
    const status = resolveThreadStatus(
      makeThread({
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: null,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-06-01T00:00:02.000Z",
        },
      }),
    );
    expect(status?.kind).toBe("working");
  });

  it("marks a running turn as working even when the session snapshot lags (null)", () => {
    // Regression: a resumed/cached shell can carry an in-progress latestTurn
    // while its `session` field is still null. The list row must still show the
    // live "Working" indicator, matching the thread detail's own pill.
    const status = resolveThreadStatus(makeThread({ session: null, latestTurn: runningTurn() }));
    expect(status?.kind).toBe("working");
  });

  it("stays quiescent for a completed turn with no session", () => {
    const status = resolveThreadStatus(
      makeThread({
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: "2026-06-01T00:00:00.000Z",
          startedAt: "2026-06-01T00:00:01.000Z",
          completedAt: "2026-06-01T00:01:00.000Z",
          assistantMessageId: null,
        },
      }),
    );
    expect(status).toBeNull();
  });

  it("prioritizes pending approvals over a running turn", () => {
    const status = resolveThreadStatus(
      makeThread({ hasPendingApprovals: true, latestTurn: runningTurn() }),
    );
    expect(status?.kind).toBe("pending-approval");
  });
});
