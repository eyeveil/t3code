import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  resolveThreadOutboxDeliveryAction,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import type { MessageId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useThreadShells } from "./entities";
import { useEnvironments } from "./environments";
import {
  claimQueuedMessageDispatch,
  dispatchingQueuedMessageIdAtom,
  editingQueuedMessageIdsAtom,
  ensureThreadOutboxLoaded,
  finishDispatchingQueuedMessage,
  removeThreadOutboxMessage,
  useThreadOutboxMessages,
  useThreadOutboxShellStatuses,
} from "./threadOutbox";
import { useThreadOutboxDelivery } from "./threadOutboxDelivery";

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

/**
 * Background drain for the web thread outbox: delivers queued messages in
 * order once their thread is idle and its environment connected. Mirrors
 * mobile's use-thread-outbox-drain, minus queued thread creations.
 */
export function useThreadOutboxDrain(): void {
  const { sendQueuedMessage } = useThreadOutboxDelivery();
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    ensureThreadOutboxLoaded();
    return () => {
      for (const timer of retryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      retryTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    for (const queuedMessages of Object.values(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }
      // Queued creations are a mobile-only concept; never deliver one here.
      if (nextQueuedMessage.creation !== undefined) {
        continue;
      }
      if (editingQueuedMessageIds[nextQueuedMessage.messageId]) {
        continue;
      }
      if ((retryNotBeforeRef.current.get(nextQueuedMessage.messageId) ?? 0) > Date.now()) {
        continue;
      }

      const thread = findThread(threads, nextQueuedMessage);
      const environment = environments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      const deliveryAction = resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: thread !== undefined,
        shellStatus,
        environmentConnected: environment?.connection.phase === "connected",
        threadBusy: thread?.session?.status === "running" || thread?.session?.status === "starting",
      });
      if (deliveryAction === "wait") {
        continue;
      }

      // A manual steer may have grabbed the slot since this effect rendered.
      if (!claimQueuedMessageDispatch(nextQueuedMessage.messageId)) {
        return;
      }
      const delivery =
        deliveryAction === "remove"
          ? removeThreadOutboxMessage(nextQueuedMessage).then(
              () => true,
              (error) => {
                console.warn("[thread-outbox] failed to remove message for a missing thread", {
                  environmentId: nextQueuedMessage.environmentId,
                  threadId: nextQueuedMessage.threadId,
                  messageId: nextQueuedMessage.messageId,
                  error,
                });
                return false;
              },
            )
          : thread !== undefined
            ? sendQueuedMessage(nextQueuedMessage, thread)
            : Promise.resolve(false);
      void delivery
        .then((sent) => {
          if (sent) {
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
            return;
          }

          const retryAttempt = (retryAttemptRef.current.get(nextQueuedMessage.messageId) ?? 0) + 1;
          retryAttemptRef.current.set(nextQueuedMessage.messageId, retryAttempt);
          const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
          retryNotBeforeRef.current.set(nextQueuedMessage.messageId, Date.now() + retryDelayMs);
          const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
          if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
          }
          const retryTimer = setTimeout(() => {
            retryTimersRef.current.delete(nextQueuedMessage.messageId);
            setRetryTick((current) => current + 1);
          }, retryDelayMs);
          retryTimersRef.current.set(nextQueuedMessage.messageId, retryTimer);
        })
        .finally(() => {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
        });
      return;
    }
  }, [
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    environments,
    queuedMessagesByThreadKey,
    retryTick,
    sendQueuedMessage,
    shellStatuses,
    threads,
  ]);
}
