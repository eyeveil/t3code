import { ThreadOutboxStorageError } from "@t3tools/client-runtime/state/thread-outbox-manager";
import type { QueuedThreadMessage } from "@t3tools/client-runtime/state/thread-outbox-model";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { webThreadOutboxStorage } from "./threadOutbox";

function createMockStorage(overrides?: Partial<Storage>): Storage {
  const map = new Map<string, string>();
  const base: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
  return { ...base, ...overrides };
}

function queuedMessage(input: {
  readonly messageId: string;
  readonly dataUrl?: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: "steer me",
    attachments:
      input.dataUrl === undefined
        ? []
        : [
            {
              id: "attachment-1",
              previewUri: "blob:preview",
              type: "image" as const,
              name: "photo.png",
              mimeType: "image/png",
              sizeBytes: input.dataUrl.length,
              dataUrl: input.dataUrl,
            },
          ],
    createdAt: "2026-07-06T10:00:01.000Z",
  };
}

describe("webThreadOutboxStorage.write", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("persists a normal message to localStorage", async () => {
    const storage = createMockStorage();
    const setItem = vi.spyOn(storage, "setItem");
    vi.stubGlobal("window", { localStorage: storage });

    const message = queuedMessage({ messageId: "message-small" });
    await expect(webThreadOutboxStorage.write(message)).resolves.toBeUndefined();

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem("t3code:thread-outbox:v1:message-small")).toContain("steer me");
  });

  it("skips persisting an oversized attachment message but does not throw", async () => {
    const storage = createMockStorage();
    const setItem = vi.spyOn(storage, "setItem");
    vi.stubGlobal("window", { localStorage: storage });

    // ~2MB base64 dataUrl, above MAX_PERSISTED_MESSAGE_BYTES (1.5MB).
    const message = queuedMessage({
      messageId: "message-huge",
      dataUrl: `data:image/png;base64,${"A".repeat(2_000_000)}`,
    });
    await expect(webThreadOutboxStorage.write(message)).resolves.toBeUndefined();

    // Never attempted the write, so localStorage stays clean and no quota throw.
    expect(setItem).not.toHaveBeenCalled();
    expect(storage.getItem("t3code:thread-outbox:v1:message-huge")).toBeNull();
  });

  it("wraps a QuotaExceededError from setItem as a structured write error", async () => {
    const quota = new DOMException("quota", "QuotaExceededError");
    const storage = createMockStorage({
      setItem: () => {
        throw quota;
      },
    });
    vi.stubGlobal("window", { localStorage: storage });

    const message = queuedMessage({ messageId: "message-quota" });
    const rejection = await webThreadOutboxStorage.write(message).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ThreadOutboxStorageError);
    expect(rejection).toMatchObject({ operation: "write", cause: quota });
  });
});
