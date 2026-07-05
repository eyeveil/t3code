import {
  ThreadOutboxStorageError,
  type ThreadOutboxStorage,
} from "@t3tools/client-runtime/state/thread-outbox-manager";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import type { MessageId } from "@t3tools/contracts";

export { ThreadOutboxStorageError, type ThreadOutboxStorage };

const THREAD_OUTBOX_DIRECTORY = "thread-outbox";

function messageFileName(messageId: MessageId): string {
  return `${encodeURIComponent(messageId)}.json`;
}

async function getOutboxDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, THREAD_OUTBOX_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

async function getMessageFile(messageId: MessageId) {
  const { File } = await import("expo-file-system");
  return new File(await getOutboxDirectory(), messageFileName(messageId));
}

export const expoThreadOutboxStorage: ThreadOutboxStorage = {
  load: async () => {
    const messages: QueuedThreadMessage[] = [];
    try {
      const { File } = await import("expo-file-system");
      const directory = await getOutboxDirectory();

      for (const entry of directory.list()) {
        if (!(entry instanceof File) || !entry.name.endsWith(".json")) {
          continue;
        }
        try {
          messages.push(decodeQueuedThreadMessage(JSON.parse(await entry.text()) as unknown));
        } catch (cause) {
          console.warn(
            "[thread-outbox] ignored invalid persisted message",
            new ThreadOutboxStorageError({
              operation: "read-message",
              environmentId: null,
              threadId: null,
              messageId: null,
              fileName: entry.name,
              cause,
            }),
          );
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
    return messages;
  },
  write: async (message) => {
    const fileName = messageFileName(message.messageId);
    try {
      const file = await getMessageFile(message.messageId);
      if (!file.exists) {
        file.create({ intermediates: true, overwrite: true });
      }
      file.write(JSON.stringify(encodeQueuedThreadMessage(message)));
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "write",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        fileName,
        cause,
      });
    }
  },
  remove: async (message) => {
    const fileName = messageFileName(message.messageId);
    try {
      const file = await getMessageFile(message.messageId);
      if (file.exists) {
        file.delete();
      }
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        fileName,
        cause,
      });
    }
  },
};
