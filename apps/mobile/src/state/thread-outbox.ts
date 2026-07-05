import { createThreadOutboxManager } from "@t3tools/client-runtime/state/thread-outbox-manager";
import type { QueuedThreadMessage } from "@t3tools/client-runtime/state/thread-outbox-model";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { expoThreadOutboxStorage } from "./thread-outbox-storage";

export * from "@t3tools/client-runtime/state/thread-outbox-model";

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadOutboxStorage,
  atomLabel: "mobile:thread-outbox:queued-messages",
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

/** Rewrite a queued message; no-op (false) if it was removed in the meantime. */
export function updateThreadOutboxMessage(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.update(message);
}

export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.remove(message);
}

export function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  return threadOutboxManager.clearEnvironment(environmentId);
}
