import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  queuedThreadMessagePreview,
  resolveQueuedThreadSettings,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./threadOutboxModel.ts";

function queuedMessage(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text?: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.text ?? input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}

describe("threadOutboxModel", () => {
  it("groups by scoped thread key, deduplicates by message id, and sorts by createdAt", () => {
    const later = queuedMessage({ messageId: "m-2", createdAt: "2026-07-06T10:00:02.000Z" });
    const earlier = queuedMessage({ messageId: "m-1", createdAt: "2026-07-06T10:00:01.000Z" });
    const otherThread = queuedMessage({
      threadId: "thread-2",
      messageId: "m-3",
      createdAt: "2026-07-06T10:00:00.000Z",
    });
    const duplicate = { ...earlier, text: "rewritten" };

    const grouped = groupQueuedThreadMessages([later, earlier, otherThread, duplicate]);
    expect(grouped).toEqual({
      "environment-1:thread-1": [duplicate, later],
      "environment-1:thread-2": [otherThread],
    });
    expect(flattenQueuedThreadMessages(grouped)).toHaveLength(3);
  });

  it("round-trips the persisted schema and rejects incomplete payloads", () => {
    const message: QueuedThreadMessage = {
      ...queuedMessage({ messageId: "m-1", createdAt: "2026-07-06T10:00:01.000Z" }),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.5",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    };

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(message))).toEqual(message);
    expect(() => decodeQueuedThreadMessage({ schemaVersion: 1, text: "" })).toThrow();
  });

  it("falls back to thread settings for fields the queued message does not pin", () => {
    const message = queuedMessage({ messageId: "m-1", createdAt: "2026-07-06T10:00:01.000Z" });
    const thread = {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
      runtimeMode: "full-access",
      interactionMode: "default",
    } as const;

    expect(resolveQueuedThreadSettings(message, thread)).toEqual(thread);
    expect(
      resolveQueuedThreadSettings({ ...message, runtimeMode: "approval-required" }, thread)
        .runtimeMode,
    ).toBe("approval-required");
  });

  it("compares model selections including options", () => {
    const base = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.5",
      options: [{ id: "reasoningEffort", value: "medium" }],
    } as const;

    expect(modelSelectionsEqual(base, { ...base })).toBe(true);
    expect(
      modelSelectionsEqual(base, { ...base, options: [{ id: "reasoningEffort", value: "high" }] }),
    ).toBe(false);
  });

  it("collapses whitespace in previews and labels attachment-only messages", () => {
    const message = queuedMessage({
      messageId: "m-1",
      createdAt: "2026-07-06T10:00:01.000Z",
      text: "\n\n  first   line\nsecond ",
    });
    expect(queuedThreadMessagePreview(message)).toBe("first line second");

    const attachment = {
      id: "image-1",
      previewUri: "file:///image-1.png",
      type: "image",
      name: "image-1.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,QQ==",
    } as const;
    expect(queuedThreadMessagePreview({ ...message, text: " ", attachments: [attachment] })).toBe(
      "1 image attachment",
    );
    expect(
      queuedThreadMessagePreview({ ...message, text: "", attachments: [attachment, attachment] }),
    ).toBe("2 image attachments");
  });

  it("backs off retries exponentially and caps at sixteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map(threadOutboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ]);
  });

  it("resolves delivery actions for existing threads", () => {
    const base = {
      isCreation: false,
      threadExists: true,
      shellStatus: "live",
      environmentConnected: true,
      threadBusy: false,
    } as const;

    expect(resolveThreadOutboxDeliveryAction(base)).toBe("send");
    expect(resolveThreadOutboxDeliveryAction({ ...base, threadBusy: true })).toBe("wait");
    expect(resolveThreadOutboxDeliveryAction({ ...base, environmentConnected: false })).toBe(
      "wait",
    );
    // A missing thread is only dropped once the shell is authoritative.
    expect(resolveThreadOutboxDeliveryAction({ ...base, threadExists: false })).toBe("remove");
    expect(
      resolveThreadOutboxDeliveryAction({ ...base, threadExists: false, shellStatus: "cached" }),
    ).toBe("wait");
  });

  it("resolves delivery actions for queued creations", () => {
    const base = {
      isCreation: true,
      threadExists: false,
      shellStatus: "live",
      environmentConnected: true,
      threadBusy: false,
    } as const;

    expect(resolveThreadOutboxDeliveryAction(base)).toBe("send");
    expect(resolveThreadOutboxDeliveryAction({ ...base, shellStatus: "synchronizing" })).toBe(
      "wait",
    );
    // Thread already exists: the creation went through; only cleanup remains.
    expect(resolveThreadOutboxDeliveryAction({ ...base, threadExists: true })).toBe("remove");
  });

  it("keeps incomplete creations queued until they would pass server validation", () => {
    const message = queuedMessage({ messageId: "m-1", createdAt: "2026-07-06T10:00:01.000Z" });
    const creation = {
      projectId: ProjectId.make("project-1"),
      workspaceMode: "worktree",
      branch: null,
      worktreePath: null,
    } as const;
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.5",
    } as const;

    expect(isQueuedThreadCreationSendable(message)).toBe(false);
    expect(isQueuedThreadCreationSendable({ ...message, creation, modelSelection })).toBe(false);
    expect(
      isQueuedThreadCreationSendable({
        ...message,
        creation: { ...creation, branch: "main" },
        modelSelection,
      }),
    ).toBe(true);
    expect(
      isQueuedThreadCreationSendable({
        ...message,
        text: "  ",
        creation: { ...creation, workspaceMode: "local" },
        modelSelection,
      }),
    ).toBe(false);
  });

  it("retries transient transport failures and discards provider rejections", () => {
    expect(shouldRetryThreadOutboxDelivery({ _tag: "ConnectionTransientError" })).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("SocketCloseError: socket closed"))).toBe(
      true,
    );
    expect(shouldRetryThreadOutboxDelivery(new Error("model not available"))).toBe(false);

    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: new Error("model not available"),
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: new Error("model not available"),
        interrupted: true,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: new Error("model not available"),
        interrupted: false,
      }),
    ).toBe("discard");
  });
});
