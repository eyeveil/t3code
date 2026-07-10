import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: EventId.make("evt-project-create"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("project-1"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-project-create"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project-1",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  const withThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("evt-thread-create"),
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
      projectId: ProjectId.make("project-1"),
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
  return yield* projectEvent(withThread, {
    sequence: 3,
    eventId: EventId.make("evt-user-message"),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type: "thread.message-sent",
    occurredAt: now,
    commandId: CommandId.make("cmd-user-message"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-user-message"),
    metadata: {},
    payload: {
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("message-1"),
      role: "user",
      text: "please do the thing",
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("decider turn redispatch", (it) => {
  it.effect("re-raises the turn intent for the existing message without a new user message", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.redispatch",
          commandId: CommandId.make("cmd-redispatch"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-2"),
            model: "gpt-5-codex",
          },
          createdAt: now,
        },
      });

      const events = Array.isArray(decided) ? decided : [decided];
      // Single-dispatch guarantee at the decider level: exactly one
      // turn-start intent, and no duplicate `thread.message-sent`.
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.type).toBe("thread.turn-start-requested");
      if (event.type !== "thread.turn-start-requested") return;
      expect(event.payload.messageId).toBe("message-1");
      expect(event.payload.modelSelection).toEqual({
        instanceId: "codex-2",
        model: "gpt-5-codex",
      });
      expect(event.payload.runtimeMode).toBe("approval-required");
    }),
  );

  it.effect("fails for unknown threads", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.redispatch",
          commandId: CommandId.make("cmd-redispatch-unknown"),
          threadId: ThreadId.make("thread-missing"),
          messageId: MessageId.make("message-1"),
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
