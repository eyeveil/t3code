import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  createThreadOutboxManager,
  ThreadOutboxStorageError,
  type ThreadOutboxStorage,
} from "@t3tools/client-runtime/state/thread-outbox-manager";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import type { EnvironmentId, MessageId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell } from "./shell";

/**
 * Per-message keys mirror mobile's per-message outbox files: enqueue, update,
 * and remove never rewrite unrelated queued messages.
 */
const THREAD_OUTBOX_STORAGE_PREFIX = "t3code:thread-outbox:v1:";

function messageStorageKey(messageId: MessageId): string {
  return `${THREAD_OUTBOX_STORAGE_PREFIX}${encodeURIComponent(messageId)}`;
}

function browserLocalStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

const webThreadOutboxStorage: ThreadOutboxStorage = {
  load: async () => {
    const storage = browserLocalStorage();
    const messages: QueuedThreadMessage[] = [];
    if (storage === null) {
      return messages;
    }
    const outboxKeys: string[] = [];
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null && key.startsWith(THREAD_OUTBOX_STORAGE_PREFIX)) {
          outboxKeys.push(key);
        }
      }
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "load",
        environmentId: null,
        threadId: null,
        messageId: null,
        fileName: null,
        cause,
      });
    }
    for (const key of outboxKeys) {
      try {
        const raw = storage.getItem(key);
        if (raw !== null) {
          messages.push(decodeQueuedThreadMessage(JSON.parse(raw) as unknown));
        }
      } catch (cause) {
        console.warn(
          "[thread-outbox] ignored invalid persisted message",
          new ThreadOutboxStorageError({
            operation: "read-message",
            environmentId: null,
            threadId: null,
            messageId: null,
            fileName: key,
            cause,
          }),
        );
      }
    }
    return messages;
  },
  write: async (message) => {
    const storage = browserLocalStorage();
    if (storage === null) {
      return;
    }
    try {
      storage.setItem(
        messageStorageKey(message.messageId),
        JSON.stringify(encodeQueuedThreadMessage(message)),
      );
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "write",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        fileName: messageStorageKey(message.messageId),
        cause,
      });
    }
  },
  remove: async (message) => {
    const storage = browserLocalStorage();
    if (storage === null) {
      return;
    }
    try {
      storage.removeItem(messageStorageKey(message.messageId));
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        fileName: messageStorageKey(message.messageId),
        cause,
      });
    }
  },
};

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: webThreadOutboxStorage,
  atomLabel: "web:thread-outbox:queued-messages",
  warn: (message, error) => {
    console.warn(message, error);
  },
});

export function ensureThreadOutboxLoaded(): void {
  void threadOutboxManager.load();
}

export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.enqueue(message);
}

export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.remove(message);
}

export function useThreadOutboxMessages(): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  return useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom);
}

/**
 * Single dispatch slot shared by the background drain and manual "steer"
 * deliveries, so a queued message can never be delivered twice concurrently.
 */
export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:thread-outbox:dispatching-message-id"),
);

/** Claims the dispatch slot; false when another delivery is already in flight. */
export function claimQueuedMessageDispatch(queuedMessageId: MessageId): boolean {
  if (appAtomRegistry.get(dispatchingQueuedMessageIdAtom) !== null) {
    return false;
  }
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
  return true;
}

export function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

/**
 * Queued messages the drain must not deliver right now (mid edit or delete),
 * so pulling a message into the composer can never race a delivery.
 */
export const editingQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:thread-outbox:editing-message-ids"),
);

export function holdEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (current[messageId]) {
    return;
  }
  appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...current, [messageId]: true });
}

export function releaseEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (!current[messageId]) {
    return;
  }
  const next = { ...current };
  delete next[messageId];
  appAtomRegistry.set(editingQueuedMessageIdsAtom, next);
}

/** Shell status per environment that currently has queued messages. */
const threadOutboxShellStatusesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> => {
    const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
    for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))) {
      const environmentId = queue[0]?.environmentId;
      if (environmentId !== undefined && !statuses.has(environmentId)) {
        statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
      }
    }
    return statuses;
  },
).pipe(Atom.withLabel("web:thread-outbox:shell-statuses"));

export function useThreadOutboxShellStatuses(): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> {
  return useAtomValue(threadOutboxShellStatusesAtom);
}
