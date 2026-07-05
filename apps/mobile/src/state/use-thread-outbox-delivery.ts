import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { randomHex } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { removeThreadOutboxMessage } from "./thread-outbox";
import {
  modelSelectionsEqual,
  resolveQueuedThreadSettings,
  resolveThreadOutboxFailureAction,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

/**
 * Single dispatch slot shared by the background drain and manual "steer"
 * deliveries, so a queued message can never be delivered twice concurrently.
 */
export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
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

function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

/**
 * Delivery of a queued outbox message: settings sync, turn start, and removal
 * from the queue on success. Shared by the background drain and the composer's
 * "steer" action so both paths stay behaviorally identical. Callers own the
 * dispatch slot (claim/finish) and any retry policy.
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

  const makeDeliveryHelpers = useCallback((queuedMessage: QueuedThreadMessage) => {
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
    const completeDelivery = async (
      deliveryResult: AtomCommandResult<unknown, unknown>,
    ): Promise<boolean> => {
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
    };
    return { reportFailure, completeDelivery };
  }, []);

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage, thread: EnvironmentThreadShell) => {
      const settings = resolveQueuedThreadSettings(queuedMessage, thread);
      const { reportFailure, completeDelivery } = makeDeliveryHelpers(queuedMessage);

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
      return completeDelivery(deliveryResult);
    },
    [
      makeDeliveryHelpers,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      startTurn,
      updateThreadMetadata,
    ],
  );

  const sendQueuedCreation = useCallback(
    async (
      queuedMessage: QueuedThreadMessage,
      creation: QueuedThreadCreation,
      projectCwd: string,
    ) => {
      const modelSelection = queuedMessage.modelSelection;
      if (modelSelection === undefined) {
        return false;
      }
      const { completeDelivery } = makeDeliveryHelpers(queuedMessage);
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: buildProjectThreadStartTurnInput({
          projectId: creation.projectId,
          projectCwd,
          threadId: queuedMessage.threadId,
          commandId: queuedMessage.commandId,
          messageId: queuedMessage.messageId,
          createdAt: queuedMessage.createdAt,
          text: queuedMessage.text.trim(),
          attachments: queuedMessage.attachments,
          modelSelection,
          runtimeMode: queuedMessage.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: queuedMessage.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceMode: creation.workspaceMode,
          branch: creation.branch,
          worktreePath: creation.worktreePath,
          startFromOrigin: creation.startFromOrigin ?? false,
          worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
        }),
      });
      return completeDelivery(deliveryResult);
    },
    [makeDeliveryHelpers, startTurn],
  );

  return { sendQueuedMessage, sendQueuedCreation };
}
