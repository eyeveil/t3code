import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  modelSelectionsEqual,
  resolveQueuedThreadSettings,
  resolveThreadOutboxFailureAction,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
  type ThreadSettingsSnapshot,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import { CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { removeThreadOutboxMessage } from "./threadOutbox";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

/**
 * Delivery of a queued outbox message: settings sync, turn start, and removal
 * from the queue on success. Shared by the background drain and the composer's
 * "steer" action so both paths stay behaviorally identical. Callers own the
 * dispatch slot (claim/finish) and any retry policy.
 *
 * Mirrors mobile's use-thread-outbox-delivery, minus queued thread creations
 * (web enqueues turns for existing threads only).
 */
export function useThreadOutboxDelivery() {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage, thread: ThreadSettingsSnapshot) => {
      const settings = resolveQueuedThreadSettings(queuedMessage, thread);

      const reportFailure = (
        commandResult: AtomCommandResult<unknown, unknown>,
        stage: ThreadOutboxCommandStage,
      ): boolean => {
        if (!AsyncResult.isFailure(commandResult)) {
          return false;
        }
        const action = resolveThreadOutboxFailureAction({
          stage,
          error: Cause.squash(commandResult.cause),
          interrupted: Cause.hasInterruptsOnly(commandResult.cause),
        });
        const retry = action === "retry";
        console.warn("[thread-outbox] queued message delivery failed", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          stage,
          cause: commandResult.cause,
          retry,
        });
        return retry;
      };

      if (!modelSelectionsEqual(settings.modelSelection, thread.modelSelection)) {
        const updateResult = await updateThreadMetadata({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "model-selection"),
            threadId: queuedMessage.threadId,
            modelSelection: settings.modelSelection,
          },
        });
        if (AsyncResult.isFailure(updateResult)) {
          reportFailure(updateResult, "settings-sync");
          return false;
        }
      }

      if (settings.runtimeMode !== thread.runtimeMode) {
        const runtimeResult = await setThreadRuntimeMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "runtime-mode"),
            threadId: queuedMessage.threadId,
            runtimeMode: settings.runtimeMode,
            createdAt: queuedMessage.createdAt,
          },
        });
        if (AsyncResult.isFailure(runtimeResult)) {
          reportFailure(runtimeResult, "settings-sync");
          return false;
        }
      }

      if (settings.interactionMode !== thread.interactionMode) {
        const interactionResult = await setThreadInteractionMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "interaction-mode"),
            threadId: queuedMessage.threadId,
            interactionMode: settings.interactionMode,
            createdAt: queuedMessage.createdAt,
          },
        });
        if (AsyncResult.isFailure(interactionResult)) {
          reportFailure(interactionResult, "settings-sync");
          return false;
        }
      }

      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: queuedMessage.commandId,
          threadId: queuedMessage.threadId,
          message: {
            messageId: queuedMessage.messageId,
            role: "user",
            text: queuedMessage.text,
            attachments: queuedMessage.attachments,
          },
          modelSelection: settings.modelSelection,
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      if (reportFailure(deliveryResult, "start-turn")) {
        return false;
      }

      try {
        await removeThreadOutboxMessage(queuedMessage);
        return true;
      } catch (error) {
        console.warn("[thread-outbox] failed to remove delivered queued message", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
        return false;
      }
    },
    [setThreadInteractionMode, setThreadRuntimeMode, startTurn, updateThreadMetadata],
  );

  return { sendQueuedMessage };
}
