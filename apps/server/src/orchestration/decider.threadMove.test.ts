import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);

const now = "2026-01-01T00:00:00.000Z";

const projectCreatedEvent = (sequence: number, projectId: string) => ({
  sequence,
  eventId: asEventId(`evt-${projectId}-create`),
  aggregateKind: "project" as const,
  aggregateId: asProjectId(projectId),
  type: "project.created" as const,
  occurredAt: now,
  commandId: CommandId.make(`cmd-${projectId}-create`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-${projectId}-create`),
  metadata: {},
  payload: {
    projectId: asProjectId(projectId),
    title: projectId,
    workspaceRoot: `/tmp/${projectId}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

// Two projects and one thread in project-a: the minimal fixture for moves.
const seedReadModel = Effect.gen(function* () {
  const withProjectA = yield* projectEvent(
    createEmptyReadModel(now),
    projectCreatedEvent(1, "project-a"),
  );
  const withProjectB = yield* projectEvent(withProjectA, projectCreatedEvent(2, "project-b"));
  return yield* projectEvent(withProjectB, {
    sequence: 3,
    eventId: asEventId("evt-thread-create"),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-thread-create"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread-create"),
    metadata: {},
    payload: {
      threadId: ThreadId.make("thread-1"),
      projectId: asProjectId("project-a"),
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("decider thread move", (it) => {
  it.effect("moves a thread to an existing project via thread.meta.update", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-thread-move"),
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-b"),
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event).toMatchObject({
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-b"),
        },
      });

      const nextReadModel = yield* projectEvent(readModel, { ...event, sequence: 4 });
      const thread = nextReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.projectId).toBe(asProjectId("project-b"));
    }),
  );

  it.effect("rejects moving a thread to a missing project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-thread-move-missing"),
            threadId: ThreadId.make("thread-1"),
            projectId: asProjectId("project-missing"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("does not exist");
    }),
  );
});
