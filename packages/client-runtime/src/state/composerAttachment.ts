import type { UploadChatImageAttachment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Composer image attachment kept in client drafts and queued outbox messages.
 * Carries the upload payload plus a client-local id and preview URI.
 */
export interface DraftComposerImageAttachment extends UploadChatImageAttachment {
  readonly id: string;
  readonly previewUri: string;
}

export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});
