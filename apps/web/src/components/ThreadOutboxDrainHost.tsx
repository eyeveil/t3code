import { useThreadOutboxDrain } from "../state/threadOutboxDrain";

/**
 * Mounts the thread-outbox background drain once for the whole renderer so
 * queued messages deliver even when no chat view is open.
 */
export function ThreadOutboxDrainHost() {
  useThreadOutboxDrain();
  return null;
}
