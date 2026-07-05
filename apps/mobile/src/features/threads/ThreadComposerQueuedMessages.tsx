import { useAtomValue } from "@effect/atom-react";
import { SymbolView } from "expo-symbols";
import type { ComponentProps } from "react";
import { memo, useCallback } from "react";
import { ActivityIndicator, Alert, Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { queuedThreadMessagePreview, type QueuedThreadMessage } from "../../state/thread-outbox";
import { dispatchingQueuedMessageIdAtom } from "../../state/use-thread-outbox-delivery";

const QUEUED_MESSAGES_HEADER_HEIGHT = 22;
const QUEUED_MESSAGE_ROW_HEIGHT = 46;

/**
 * Initial feed-inset estimate for the queue block; the composer overlay's
 * onLayout measurement refines it once rendered.
 */
export function estimatedQueuedMessagesHeight(count: number): number {
  return count > 0 ? QUEUED_MESSAGES_HEADER_HEIGHT + count * QUEUED_MESSAGE_ROW_HEIGHT : 0;
}

function QueuedMessageActionButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly tintColor: ColorValue;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
      style={{ opacity: props.disabled ? 0.35 : 1 }}
    >
      <SymbolView name={props.icon} size={15} tintColor={props.tintColor} type="monochrome" />
    </Pressable>
  );
}

/**
 * Codex-desktop-style visible outbox: one row per queued message with
 * steer / edit / delete inline actions, rendered directly above the composer.
 */
export const ThreadComposerQueuedMessages = memo(function ThreadComposerQueuedMessages(props: {
  readonly messages: ReadonlyArray<QueuedThreadMessage>;
  /** Steering needs a live connection; the drain keeps retrying without one. */
  readonly steerEnabled: boolean;
  readonly onSteer: (message: QueuedThreadMessage) => Promise<void>;
  readonly onEdit: (message: QueuedThreadMessage) => Promise<void>;
  readonly onDelete: (message: QueuedThreadMessage) => Promise<void>;
}) {
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const iconColor = useThemeColor("--color-icon");
  const dangerColor = useThemeColor("--color-danger-foreground");
  const spinnerColor = useThemeColor("--color-foreground-tertiary");
  const { onDelete } = props;

  const confirmDelete = useCallback(
    (message: QueuedThreadMessage) => {
      Alert.alert(
        "Delete queued message?",
        "It has not been sent yet and will be removed from the queue.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => void onDelete(message) },
        ],
      );
    },
    [onDelete],
  );

  if (props.messages.length === 0) {
    return null;
  }

  return (
    <View className="gap-1.5 pb-2">
      <Text
        className="px-1 text-xs font-t3-medium text-foreground-muted"
        style={{ height: QUEUED_MESSAGES_HEADER_HEIGHT }}
      >
        {props.messages.length} queued
      </Text>
      {props.messages.map((message) => {
        const dispatching = dispatchingQueuedMessageId === message.messageId;
        return (
          <View
            key={message.messageId}
            className="flex-row items-center rounded-2xl border border-border bg-card py-0.5 pl-3 pr-1 shadow-sm"
          >
            {/* flex-1 + numberOfLines clips the preview to the composer width. */}
            <Text numberOfLines={1} className="flex-1 pr-1 text-sm text-foreground">
              {queuedThreadMessagePreview(message)}
            </Text>
            {dispatching ? (
              <View className="h-9 w-9 items-center justify-center">
                <ActivityIndicator size="small" color={spinnerColor} />
              </View>
            ) : (
              <QueuedMessageActionButton
                accessibilityLabel="Steer: send into the running turn now"
                icon={{ ios: "arrow.up", android: "arrow_upward" }}
                tintColor={iconColor}
                disabled={!props.steerEnabled}
                onPress={() => void props.onSteer(message)}
              />
            )}
            <QueuedMessageActionButton
              accessibilityLabel="Edit queued message"
              icon={{ ios: "pencil", android: "edit" }}
              tintColor={iconColor}
              disabled={dispatching}
              onPress={() => void props.onEdit(message)}
            />
            <QueuedMessageActionButton
              accessibilityLabel="Delete queued message"
              icon={{ ios: "trash", android: "delete" }}
              tintColor={dangerColor}
              disabled={dispatching}
              onPress={() => confirmDelete(message)}
            />
          </View>
        );
      })}
    </View>
  );
});
