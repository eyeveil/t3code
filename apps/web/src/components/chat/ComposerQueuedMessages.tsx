import type { QueuedThreadMessage } from "@t3tools/client-runtime/state/thread-outbox-model";
import { queuedThreadMessagePreview } from "@t3tools/client-runtime/state/thread-outbox-model";
import type { MessageId } from "@t3tools/contracts";
import { ArrowUpIcon, LoaderIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";

/**
 * Visible outbox above the composer: one row per queued message with
 * steer / edit / delete inline actions. Web counterpart of mobile's
 * ThreadComposerQueuedMessages.
 */
export const ComposerQueuedMessages = memo(function ComposerQueuedMessages(props: {
  readonly messages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: MessageId | null;
  /** Steering needs a live connection; the drain keeps retrying without one. */
  readonly steerEnabled: boolean;
  readonly onSteer: (message: QueuedThreadMessage) => void;
  readonly onEdit: (message: QueuedThreadMessage) => void;
  readonly onDelete: (message: QueuedThreadMessage) => void;
}) {
  if (props.messages.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto mb-2 w-full min-w-0 max-w-3xl">
      <div className="flex flex-col gap-1.5">
        <span className="px-1 font-medium text-muted-foreground text-xs">
          {props.messages.length} queued
        </span>
        {props.messages.map((message) => {
          const dispatching = props.dispatchingMessageId === message.messageId;
          return (
            <div
              key={message.messageId}
              className="chat-composer-glass flex items-center gap-0.5 rounded-2xl border border-border py-1 pr-1 pl-3.5 shadow-sm"
            >
              <span className="min-w-0 flex-1 truncate pr-1 text-foreground text-sm">
                {queuedThreadMessagePreview(message)}
              </span>
              {dispatching ? (
                <span className="flex size-8 items-center justify-center sm:size-7">
                  <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                </span>
              ) : (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Steer: send into the running turn now"
                  title="Steer: send into the running turn now"
                  disabled={!props.steerEnabled}
                  onClick={() => props.onSteer(message)}
                >
                  <ArrowUpIcon className="size-3.5" />
                </Button>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Edit queued message"
                title="Edit queued message"
                disabled={dispatching}
                onClick={() => props.onEdit(message)}
              >
                <PencilIcon className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Delete queued message"
                title="Delete queued message"
                disabled={dispatching}
                onClick={() => props.onDelete(message)}
              >
                <Trash2Icon className="size-3.5 text-destructive-foreground" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
