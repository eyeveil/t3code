import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ExtensionCommandContextActions,
  type ExtensionError,
  type ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import {
  EventId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ChatAttachment,
  type PiSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { Effect, PubSub, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { parsePiSlashCommand, PI_BUILT_IN_SLASH_COMMANDS } from "../pi/PiSlashCommands.ts";
import { makePiExtensionUiBridge, type PiExtensionUiBridge } from "../pi/PiExtensionUiBridge.ts";
import { toPiJsonValue } from "../pi/jsonSafe.ts";
import {
  getPiExtensionInventoryFromRunner,
  piModelToServerModel,
  resolvePiAgentDir,
  resolvePiSessionDir,
} from "./PiProvider.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const PI_BUILT_IN_SLASH_COMMAND_NAMES = new Set(
  PI_BUILT_IN_SLASH_COMMANDS.map((command) => command.name),
);
type PiThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];
type PiTurnCompletionState = Extract<
  ProviderRuntimeEvent,
  { readonly type: "turn.completed" }
>["payload"]["state"];
type PiRuntimeEventPublisher = (event: ProviderRuntimeEvent) => Promise<void>;

function publishPiRuntimeEvent(
  pubSub: PubSub.PubSub<ProviderRuntimeEvent>,
  event: ProviderRuntimeEvent,
) {
  return Effect.runPromise(PubSub.publish(pubSub, event).pipe(Effect.asVoid));
}

export interface PiAdapterOptions {
  readonly instanceId?: ProviderInstanceId | undefined;
}

interface PiResumeCursor {
  readonly schemaVersion: 1;
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly leafId?: string | undefined;
  readonly cwd: string;
  readonly agentDir?: string | undefined;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly session: AgentSession;
  readonly modelRegistry: ModelRegistry;
  readonly unsubscribe: () => void;
  readonly turns: Array<{ readonly id: TurnId; readonly items: ReadonlyArray<unknown> }>;
  activeTurnId: TurnId | undefined;
  extensionUiBridge: PiExtensionUiBridge | undefined;
  providerSession: ProviderSession;
  resumeCursor: PiResumeCursor | undefined;
}

type PiRuntimeEventContext = Pick<
  PiSessionContext,
  "threadId" | "providerInstanceId" | "activeTurnId"
>;

function nowIso() {
  return new Date().toISOString();
}

function nextEventId() {
  return EventId.make(crypto.randomUUID());
}

function noop() {}

function makeRuntimeItemId(value: string) {
  return RuntimeItemId.make(value);
}

function isPiThinkingLevel(value: string | undefined): value is PiThinkingLevel {
  return PI_THINKING_LEVELS.some((level) => level === value);
}

function resolvePiThinkingLevel(
  modelSelection: ModelSelection | null | undefined,
): PiThinkingLevel | undefined {
  const selected =
    getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
    getModelSelectionStringOptionValue(modelSelection, "effort");
  return isPiThinkingLevel(selected) ? selected : undefined;
}

function parsePiModelSlug(
  modelSlug: string | null | undefined,
): { readonly provider: string; readonly modelId: string } | undefined {
  if (!modelSlug || modelSlug === "auto") {
    return undefined;
  }
  const separatorIndex = modelSlug.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === modelSlug.length - 1) {
    return undefined;
  }
  return {
    provider: modelSlug.slice(0, separatorIndex),
    modelId: modelSlug.slice(separatorIndex + 1),
  };
}

function resolvePiModelSelection(input: {
  readonly modelRegistry: ModelRegistry;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection | null | undefined;
}): {
  readonly modelSlug?: string | undefined;
  readonly model?: AgentSession["model"] | undefined;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
} {
  if (input.modelSelection?.instanceId !== input.providerInstanceId) {
    return {};
  }
  const modelSlug = input.modelSelection.model;
  const parsed = parsePiModelSlug(modelSlug);
  const model = parsed ? input.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
  const thinkingLevel = resolvePiThinkingLevel(input.modelSelection);
  return {
    ...(modelSlug ? { modelSlug } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function piModelsEqual(
  a: AgentSession["model"] | null | undefined,
  b: NonNullable<AgentSession["model"]>,
): boolean {
  return a?.provider === b.provider && a.id === b.id;
}

function decodePiResumeCursor(value: unknown): PiResumeCursor | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<Record<keyof PiResumeCursor, unknown>>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.sessionFile !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.cwd !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    sessionFile: record.sessionFile,
    sessionId: record.sessionId,
    cwd: record.cwd,
    ...(typeof record.leafId === "string" ? { leafId: record.leafId } : {}),
    ...(typeof record.agentDir === "string" ? { agentDir: record.agentDir } : {}),
  };
}

function buildPiResumeCursor(context: PiSessionContext): PiResumeCursor | undefined {
  const sessionFile = context.session.sessionManager.getSessionFile();
  if (!sessionFile) {
    return undefined;
  }
  const leafId = context.session.sessionManager.getLeafId();
  return {
    schemaVersion: 1,
    sessionFile,
    sessionId: context.session.sessionManager.getSessionId(),
    cwd: context.cwd,
    ...(leafId ? { leafId } : {}),
  };
}

function toAdapterError(
  provider: string,
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterRequestError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail,
    cause,
  });
}

function piToolItemType(toolName: string): ToolLifecycleItemType {
  switch (toolName) {
    case "bash":
    case "exec":
      return "command_execution";
    case "edit":
    case "write":
      return "file_change";
    default:
      return "dynamic_tool_call";
  }
}

function stringifyDisplayValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? truncateSummaryText(trimmed) : undefined;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => stringifyDisplayValue(entry)).filter(Boolean);
    return parts.length > 0 ? truncateSummaryText(parts.join("\n")) : undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const textKeys = ["stdout", "stderr", "content", "output", "text", "message", "result"];
    const parts = textKeys.map((key) => stringifyDisplayValue(record[key])).filter(Boolean);
    if (parts.length > 0) {
      return truncateSummaryText(parts.join("\n"));
    }
  }
  return undefined;
}

function piToolDisplayPayload(
  event: Extract<AgentSessionEvent, { readonly type: "tool_execution_end" }>,
) {
  const detail = stringifyDisplayValue(event.result);
  return {
    itemType: piToolItemType(event.toolName),
    status: event.isError ? ("failed" as const) : ("completed" as const),
    title: event.toolName,
    ...(detail ? { detail } : {}),
    data: {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      rawOutput: summarizeUnknown(event.result),
    },
  };
}

const SUMMARY_STRING_LIMIT = 1_200;
const SUMMARY_COLLECTION_LIMIT = 6;
const SUMMARY_DEPTH_LIMIT = 2;

function truncateSummaryText(value: string): string {
  if (value.length <= SUMMARY_STRING_LIMIT) {
    return value;
  }
  return `${value.slice(0, SUMMARY_STRING_LIMIT)}... [truncated ${value.length - SUMMARY_STRING_LIMIT} chars]`;
}

function summarizeUnknown(value: unknown, depth = 0): unknown {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return truncateSummaryText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return typeof value;
  }
  if (value instanceof Uint8Array) {
    return { kind: "bytes", length: value.byteLength };
  }
  if (depth >= SUMMARY_DEPTH_LIMIT) {
    if (Array.isArray(value)) {
      return { kind: "array", length: value.length };
    }
    if (typeof value === "object") {
      return { kind: "object", keys: Object.keys(value as Record<string, unknown>).length };
    }
  }
  if (Array.isArray(value)) {
    const preview = value
      .slice(0, SUMMARY_COLLECTION_LIMIT)
      .map((entry) => summarizeUnknown(entry, depth + 1));
    return value.length > SUMMARY_COLLECTION_LIMIT || depth >= SUMMARY_DEPTH_LIMIT
      ? { kind: "array", length: value.length, preview }
      : preview;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const summary: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, SUMMARY_COLLECTION_LIMIT)) {
      summary[key] = summarizeUnknown(entry, depth + 1);
    }
    if (entries.length > SUMMARY_COLLECTION_LIMIT) {
      summary._truncatedKeys = entries.length - SUMMARY_COLLECTION_LIMIT;
    }
    return summary;
  }
  return String(value);
}

function summarizeAgentMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return summarizeUnknown(message);
  }
  const record = message as Record<string, unknown>;
  return {
    role: summarizeUnknown(record.role),
    provider: summarizeUnknown(record.provider),
    model: summarizeUnknown(record.model),
    stopReason: summarizeUnknown(record.stopReason),
    errorMessage: summarizeUnknown(record.errorMessage),
    content: summarizeUnknown(record.content),
  };
}

function sanitizePiRawPayload(event: AgentSessionEvent): unknown {
  switch (event.type) {
    case "agent_start":
      return { type: event.type };
    case "agent_end":
      return { type: event.type, messageCount: event.messages.length };
    case "turn_start":
      return { type: event.type };
    case "turn_end":
      return {
        type: event.type,
        message: summarizeAgentMessage(event.message),
        toolResultsCount: event.toolResults.length,
      };
    case "message_start":
    case "message_end":
      return { type: event.type, message: summarizeAgentMessage(event.message) };
    case "message_update":
      return {
        type: event.type,
        message: summarizeAgentMessage(event.message),
        assistantMessageEvent: summarizeUnknown({
          type: event.assistantMessageEvent.type,
          contentIndex:
            "contentIndex" in event.assistantMessageEvent
              ? event.assistantMessageEvent.contentIndex
              : undefined,
          deltaLength:
            "delta" in event.assistantMessageEvent &&
            typeof event.assistantMessageEvent.delta === "string"
              ? event.assistantMessageEvent.delta.length
              : undefined,
          reason:
            "reason" in event.assistantMessageEvent
              ? event.assistantMessageEvent.reason
              : undefined,
        }),
      };
    case "tool_execution_start":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: summarizeUnknown(event.args),
      };
    case "tool_execution_update":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: summarizeUnknown(event.args),
        partialResult: summarizeUnknown(event.partialResult),
      };
    case "tool_execution_end":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: summarizeUnknown(event.result),
        isError: event.isError,
      };
    case "queue_update":
      return {
        type: event.type,
        steeringCount: event.steering.length,
        followUpCount: event.followUp.length,
      };
    case "compaction_start":
      return { type: event.type, reason: event.reason };
    case "compaction_end":
      return {
        type: event.type,
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        errorMessage: summarizeUnknown(event.errorMessage),
      };
    case "session_info_changed":
      return { type: event.type, name: event.name };
    case "thinking_level_changed":
      return { type: event.type, level: event.level };
    case "auto_retry_start":
      return {
        type: event.type,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: summarizeUnknown(event.errorMessage),
      };
    case "auto_retry_end":
      return {
        type: event.type,
        success: event.success,
        attempt: event.attempt,
        finalError: summarizeUnknown(event.finalError),
      };
  }
}

function makeBaseEvent(context: PiRuntimeEventContext, event: AgentSessionEvent) {
  return {
    eventId: nextEventId(),
    provider: PROVIDER,
    providerInstanceId: context.providerInstanceId,
    threadId: context.threadId,
    createdAt: nowIso(),
    ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
    raw: {
      source: "pi.sdk.event" as const,
      messageType: event.type,
      payload: sanitizePiRawPayload(event),
    },
  };
}

function makeContextEventBase(context: PiRuntimeEventContext, turnId?: TurnId | undefined) {
  return {
    eventId: nextEventId(),
    provider: PROVIDER,
    providerInstanceId: context.providerInstanceId,
    threadId: context.threadId,
    ...(turnId ? { turnId } : {}),
    createdAt: nowIso(),
  };
}

function trimText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractPiTextContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return trimText(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const text = trimText(record.text);
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function extractPiDisplayMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const record = message as Record<string, unknown>;
  if (record.role === "assistant") {
    return extractPiTextContent(record.content);
  }
  if (record.role === "custom" && record.display === true) {
    return extractPiTextContent(record.content);
  }
  return undefined;
}

export function mapPiDisplayMessageEndEvent(
  context: PiRuntimeEventContext,
  event: Extract<AgentSessionEvent, { readonly type: "message_end" }>,
): ReadonlyArray<ProviderRuntimeEvent> {
  const text = extractPiDisplayMessageText(event.message);
  if (!text) {
    return [];
  }

  return [
    {
      ...makeBaseEvent(context, event),
      type: "item.completed",
      itemId: makeRuntimeItemId(`message:${crypto.randomUUID()}`),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Pi message",
        detail: text,
      },
    },
  ];
}

function mapPiAssistantMessageEvent(
  context: PiSessionContext,
  event: Extract<AgentSessionEvent, { readonly type: "message_update" }>,
): ReadonlyArray<ProviderRuntimeEvent> {
  const assistantEvent = event.assistantMessageEvent;
  if (assistantEvent.type === "text_delta") {
    return [
      {
        ...makeBaseEvent(context, event),
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: assistantEvent.delta,
          contentIndex: assistantEvent.contentIndex,
        },
      },
    ];
  }
  if (assistantEvent.type === "thinking_delta") {
    return [
      {
        ...makeBaseEvent(context, event),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta: assistantEvent.delta,
          contentIndex: assistantEvent.contentIndex,
        },
      },
    ];
  }
  if (assistantEvent.type === "error") {
    return [
      {
        ...makeBaseEvent(context, event),
        type: "runtime.error",
        payload: {
          class: "provider_error",
          message: assistantEvent.error.errorMessage ?? "Pi provider error",
        },
      },
    ];
  }
  return [];
}

function mapPiEvent(
  context: PiSessionContext,
  event: AgentSessionEvent,
): ReadonlyArray<ProviderRuntimeEvent> {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
    case "turn_start":
    case "turn_end":
      return [];
    case "message_update":
      return mapPiAssistantMessageEvent(context, event);
    case "tool_execution_start":
      return [
        {
          ...makeBaseEvent(context, event),
          type: "item.started",
          itemId: makeRuntimeItemId(event.toolCallId),
          payload: {
            itemType: piToolItemType(event.toolName),
            status: "inProgress",
            title: event.toolName,
            data: { args: summarizeUnknown(event.args) },
          },
        },
      ];
    case "tool_execution_update":
      return [
        {
          ...makeBaseEvent(context, event),
          type: "item.updated",
          itemId: makeRuntimeItemId(event.toolCallId),
          payload: {
            itemType: piToolItemType(event.toolName),
            status: "inProgress",
            title: event.toolName,
            data: {
              args: summarizeUnknown(event.args),
              partialResult: summarizeUnknown(event.partialResult),
            },
          },
        },
      ];
    case "tool_execution_end":
      return [
        {
          ...makeBaseEvent(context, event),
          type: "item.completed",
          itemId: makeRuntimeItemId(event.toolCallId),
          payload: piToolDisplayPayload(event),
        },
      ];
    case "message_end":
      return mapPiDisplayMessageEndEvent(context, event);
    case "queue_update":
    case "message_start":
    case "compaction_start":
    case "compaction_end":
    case "session_info_changed":
    case "thinking_level_changed":
    case "auto_retry_start":
    case "auto_retry_end":
      return [];
  }
}

async function resolvePiImages(input: {
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
}) {
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const attachment of input.attachments ?? []) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      throw new Error(`Invalid attachment id '${attachment.id}'.`);
    }
    const bytes = await readFile(attachmentPath);
    images.push({
      type: "image",
      data: bytes.toString("base64"),
      mimeType: attachment.mimeType,
    });
  }
  return images;
}

async function dispatchPiSlashCommand(input: {
  readonly context: PiSessionContext;
  readonly name: string;
  readonly args: string;
  readonly turnId: TurnId;
  readonly publishRuntimeEvent: PiRuntimeEventPublisher;
}) {
  switch (input.name) {
    case "compact":
      await input.context.session.compact(input.args || undefined);
      return true;
    case "reload":
      await input.context.session.reload();
      return true;
    case "name":
      input.context.session.sessionManager.appendSessionInfo(input.args.trim());
      return true;
    default:
      if (PI_BUILT_IN_SLASH_COMMAND_NAMES.has(input.name)) {
        await publishPiRuntimeWarning({
          context: input.context,
          turnId: input.turnId,
          publishRuntimeEvent: input.publishRuntimeEvent,
          message: `Pi command /${input.name} needs Pi's interactive UI and is not available in T3 yet.`,
        });
        return true;
      }
      return false;
  }
}

async function publishPiRuntimeWarning(input: {
  readonly context: PiSessionContext;
  readonly turnId?: TurnId | undefined;
  readonly publishRuntimeEvent: PiRuntimeEventPublisher;
  readonly message: string;
  readonly detail?: unknown;
}) {
  const detail = toPiJsonValue(input.detail);
  await input.publishRuntimeEvent({
    ...makeContextEventBase(input.context, input.turnId),
    type: "runtime.warning",
    payload: {
      message: input.message,
      ...(detail !== undefined ? { detail } : {}),
    },
  });
}

async function publishPiExtensionDiagnostic(input: {
  readonly context: PiSessionContext;
  readonly publishRuntimeEvent: PiRuntimeEventPublisher;
  readonly message: string;
  readonly severity?: "info" | "warning" | "error";
  readonly event?: string;
  readonly diagnosticKey?: string;
  readonly repeatCount?: number;
  readonly hiddenCount?: number;
  readonly detail?: unknown;
  readonly extensionPath?: string;
}) {
  const detail = toPiJsonValue(input.detail);
  await input.publishRuntimeEvent({
    ...makeContextEventBase(input.context, input.context.activeTurnId),
    type: "pi.extension.diagnostic",
    payload: {
      source: "pi.extension",
      message: input.message,
      severity: input.severity ?? "warning",
      visibility: "pi-panel",
      ...(input.extensionPath ? { extensionPath: input.extensionPath } : {}),
      ...(input.event ? { event: input.event } : {}),
      ...(input.diagnosticKey ? { diagnosticKey: input.diagnosticKey } : {}),
      ...(input.repeatCount ? { repeatCount: input.repeatCount } : {}),
      ...(input.hiddenCount !== undefined ? { hiddenCount: input.hiddenCount } : {}),
      ...(detail !== undefined ? { detail } : {}),
      uiOnly: true,
    },
  });
}

function extensionErrorMessage(error: ExtensionError): string {
  const source = error.extensionPath.trim() || "Pi extension";
  const event = error.event.trim();
  const detail = error.error.trim();
  return `${source}${event ? ` failed during ${event}` : " failed"}${detail ? `: ${detail}` : "."}`;
}

function extensionDiagnosticKey(error: ExtensionError): string {
  return [
    error.extensionPath.trim() || "Pi extension",
    error.event.trim(),
    error.error.trim(),
  ].join(" :: ");
}

function shouldPublishExtensionDiagnostic(count: number): boolean {
  return count === 1 || count === 2 || count === 5 || count === 10 || count % 100 === 0;
}

function getPiExtensionConfigSnapshot(context: PiSessionContext) {
  const runner = context.session.extensionRunner;
  const models = context.modelRegistry.getAvailable().map(piModelToServerModel);
  const inventory = getPiExtensionInventoryFromRunner(runner);
  return {
    ...inventory,
    models,
  };
}

async function publishPiExtensionConfig(input: {
  readonly context: PiSessionContext;
  readonly publishRuntimeEvent: PiRuntimeEventPublisher;
}) {
  const config = getPiExtensionConfigSnapshot(input.context);
  const models = toPiJsonValue(config.models);
  await input.publishRuntimeEvent({
    ...makeContextEventBase(input.context, input.context.activeTurnId),
    type: "pi.extension.configured",
    payload: {
      source: "pi.extension",
      extensionPaths: config.extensionPaths,
      slashCommands: config.slashCommands,
      tools: config.tools,
      flags: config.flags,
      ...(Array.isArray(models) ? { models } : {}),
    },
  });
}

async function bindPiExtensions(input: {
  readonly context: PiSessionContext;
  readonly publishRuntimeEvent: PiRuntimeEventPublisher;
  readonly uiContext: ExtensionUIContext;
}) {
  const diagnosticCounts = new Map<string, number>();
  const commandContextActions: ExtensionCommandContextActions = {
    waitForIdle: () => input.context.session.agent.waitForIdle(),
    newSession: async () => {
      await publishPiRuntimeWarning({
        context: input.context,
        publishRuntimeEvent: input.publishRuntimeEvent,
        message:
          "Pi extension requested a new session, but T3 session replacement is not implemented yet.",
      });
      return { cancelled: true };
    },
    fork: async () => {
      await publishPiRuntimeWarning({
        context: input.context,
        publishRuntimeEvent: input.publishRuntimeEvent,
        message: "Pi extension requested a fork, but T3 Pi session forking is not implemented yet.",
      });
      return { cancelled: true };
    },
    navigateTree: async () => {
      await publishPiRuntimeWarning({
        context: input.context,
        publishRuntimeEvent: input.publishRuntimeEvent,
        message:
          "Pi extension requested session-tree navigation, but T3 Pi tree navigation is not implemented yet.",
      });
      return { cancelled: true };
    },
    switchSession: async () => {
      await publishPiRuntimeWarning({
        context: input.context,
        publishRuntimeEvent: input.publishRuntimeEvent,
        message:
          "Pi extension requested a session switch, but T3 Pi session switching is not implemented yet.",
      });
      return { cancelled: true };
    },
    reload: async () => {
      await input.context.session.reload();
      await publishPiExtensionConfig({
        context: input.context,
        publishRuntimeEvent: input.publishRuntimeEvent,
      });
    },
  };

  await input.context.session.bindExtensions({
    uiContext: input.uiContext,
    commandContextActions,
    shutdownHandler: () => {
      void publishPiRuntimeWarning({
        context: input.context,
        publishRuntimeEvent: input.publishRuntimeEvent,
        message:
          "Pi extension requested shutdown; close the T3 thread or stop the session instead.",
      });
    },
    onError: (error) => {
      const diagnosticKey = extensionDiagnosticKey(error);
      const repeatCount = (diagnosticCounts.get(diagnosticKey) ?? 0) + 1;
      diagnosticCounts.set(diagnosticKey, repeatCount);
      if (!shouldPublishExtensionDiagnostic(repeatCount)) {
        return;
      }
      void publishPiExtensionDiagnostic({
        context: input.context,
        publishRuntimeEvent: input.publishRuntimeEvent,
        message: extensionErrorMessage(error),
        severity: "error",
        extensionPath: error.extensionPath,
        event: error.event,
        diagnosticKey,
        repeatCount,
        hiddenCount: Math.max(0, repeatCount - 1),
        detail: error,
      });
    },
  });
}

async function applyPiModelSelection(input: {
  readonly context: PiSessionContext;
  readonly modelSelection: ModelSelection | null | undefined;
}): Promise<{
  readonly modelSlug?: string | undefined;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
}> {
  const selected = resolvePiModelSelection({
    modelRegistry: input.context.modelRegistry,
    providerInstanceId: input.context.providerInstanceId,
    modelSelection: input.modelSelection,
  });
  if (selected.model && !piModelsEqual(input.context.session.model, selected.model)) {
    await input.context.session.setModel(selected.model);
  }
  if (selected.thinkingLevel) {
    input.context.session.setThinkingLevel(selected.thinkingLevel);
  }
  if (selected.modelSlug) {
    input.context.providerSession = {
      ...input.context.providerSession,
      model: selected.modelSlug,
      updatedAt: nowIso(),
    };
  }
  return {
    ...(selected.modelSlug ? { modelSlug: selected.modelSlug } : {}),
    ...(selected.thinkingLevel ? { thinkingLevel: selected.thinkingLevel } : {}),
  };
}

function errorMessageFromCause(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const trimmed = message.trim();
  return trimmed ? truncateSummaryText(trimmed) : "Pi provider error";
}

function getTurnCompletionState(session: AgentSession): PiTurnCompletionState {
  const messages = session.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as unknown as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    if (record.stopReason === "aborted") {
      return "interrupted";
    }
    if (record.stopReason === "error") {
      return "failed";
    }
    return "completed";
  }
  return "completed";
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterOptions) {
  return Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const providerInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const sessions = new Map<ThreadId, PiSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);
    const publishRuntimeEvent: PiRuntimeEventPublisher = (event) =>
      publishPiRuntimeEvent(runtimeEventPubSub, event);

    const requireSession = (threadId: ThreadId) =>
      Effect.flatMap(
        Effect.sync(() => sessions.get(threadId)),
        (context) =>
          context
            ? Effect.succeed(context)
            : Effect.fail(
                new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
              ),
      );

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const cwd = input.cwd ?? process.cwd();
          const agentDir = resolvePiAgentDir(piSettings);
          const sessionDir = resolvePiSessionDir(piSettings);
          const resumeCursor = decodePiResumeCursor(input.resumeCursor);
          const sessionManager = resumeCursor?.sessionFile
            ? SessionManager.open(resumeCursor.sessionFile, sessionDir, cwd)
            : SessionManager.create(cwd, sessionDir);
          const authStorage = AuthStorage.create(
            agentDir ? join(agentDir, "auth.json") : undefined,
          );
          const modelRegistry = ModelRegistry.create(
            authStorage,
            agentDir ? `${agentDir}/models.json` : undefined,
          );
          const selectedModel = resolvePiModelSelection({
            modelRegistry,
            providerInstanceId,
            modelSelection: input.modelSelection,
          });
          const createOptions: CreateAgentSessionOptions = {
            cwd,
            ...(agentDir ? { agentDir } : {}),
            sessionManager,
            sessionStartEvent: {
              type: "session_start" as const,
              reason: resumeCursor ? ("resume" as const) : ("startup" as const),
            },
            ...(selectedModel.model ? { model: selectedModel.model } : {}),
            ...(selectedModel.thinkingLevel ? { thinkingLevel: selectedModel.thinkingLevel } : {}),
          };
          const { session } = await createAgentSession(createOptions);
          const providerSession: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId,
            status: "ready",
            runtimeMode: "full-access",
            cwd,
            ...(selectedModel.modelSlug ? { model: selectedModel.modelSlug } : {}),
            threadId: input.threadId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          let unsubscribe = noop;
          const liveContext: PiSessionContext = {
            threadId: input.threadId,
            providerInstanceId,
            cwd,
            session,
            modelRegistry,
            unsubscribe: () => unsubscribe(),
            turns: [],
            extensionUiBridge: undefined,
            providerSession,
            resumeCursor: undefined,
            activeTurnId: undefined,
          };
          const extensionUiBridge = makePiExtensionUiBridge({
            getContext: () => ({
              threadId: liveContext.threadId,
              providerInstanceId: liveContext.providerInstanceId,
              activeTurnId: liveContext.activeTurnId,
            }),
            publishRuntimeEvent,
          });
          liveContext.extensionUiBridge = extensionUiBridge;
          unsubscribe = session.subscribe((event) => {
            const mapped = mapPiEvent(liveContext, event);
            for (const runtimeEvent of mapped) {
              void publishRuntimeEvent(runtimeEvent);
            }
          });
          sessions.set(input.threadId, liveContext);
          try {
            await bindPiExtensions({
              context: liveContext,
              publishRuntimeEvent,
              uiContext: extensionUiBridge.uiContext,
            });
            await publishPiExtensionConfig({
              context: liveContext,
              publishRuntimeEvent,
            });
          } catch (cause) {
            extensionUiBridge.dispose();
            liveContext.unsubscribe();
            session.dispose();
            sessions.delete(input.threadId);
            throw cause;
          }
          liveContext.resumeCursor = buildPiResumeCursor(liveContext);
          liveContext.providerSession = {
            ...providerSession,
            resumeCursor: liveContext.resumeCursor,
          };

          await publishRuntimeEvent({
            type: "session.started",
            eventId: nextEventId(),
            provider: PROVIDER,
            providerInstanceId,
            threadId: input.threadId,
            createdAt: nowIso(),
            payload: { resume: liveContext.resumeCursor },
          });
          await publishRuntimeEvent({
            type: "thread.started",
            eventId: nextEventId(),
            provider: PROVIDER,
            providerInstanceId,
            threadId: input.threadId,
            createdAt: nowIso(),
            payload: { providerThreadId: session.sessionId },
          });

          return liveContext.providerSession;
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        try {
          const turnId = TurnId.make(crypto.randomUUID());
          const text = input.input?.trim() ?? "";
          if (!text && (!input.attachments || input.attachments.length === 0)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }
          const selection = yield* Effect.tryPromise({
            try: () =>
              applyPiModelSelection({
                context,
                modelSelection: input.modelSelection,
              }),
            catch: (cause) =>
              toAdapterError(PROVIDER, input.threadId, "session/model-selection", cause),
          });

          context.activeTurnId = turnId;
          context.providerSession = {
            ...context.providerSession,
            status: "running",
            activeTurnId: turnId,
            updatedAt: nowIso(),
          };

          yield* offerRuntimeEvent({
            type: "session.state.changed",
            eventId: nextEventId(),
            provider: PROVIDER,
            providerInstanceId,
            threadId: input.threadId,
            turnId,
            createdAt: nowIso(),
            payload: { state: "running" },
          });
          yield* offerRuntimeEvent({
            type: "turn.started",
            eventId: nextEventId(),
            provider: PROVIDER,
            providerInstanceId,
            threadId: input.threadId,
            turnId,
            createdAt: nowIso(),
            payload: {
              ...(selection.modelSlug ? { model: selection.modelSlug } : {}),
              ...(selection.thinkingLevel ? { effort: selection.thinkingLevel } : {}),
            },
          });

          context.resumeCursor = buildPiResumeCursor(context);

          const runTurn = async () => {
            let completionState: PiTurnCompletionState = "completed";
            let errorMessage: string | undefined;
            const turnStartMessageCount = context.session.messages.length;
            try {
              const parsed = parsePiSlashCommand(text);
              const handled = parsed
                ? await dispatchPiSlashCommand({
                    context,
                    name: parsed.name,
                    args: parsed.args,
                    turnId,
                    publishRuntimeEvent,
                  })
                : false;
              if (!handled) {
                const images = await resolvePiImages({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachments: input.attachments,
                });
                await context.session.prompt(text, {
                  source: "rpc",
                  ...(images.length > 0 ? { images } : {}),
                });
              }
              completionState = getTurnCompletionState(context.session);
            } catch (cause) {
              completionState = "failed";
              errorMessage = errorMessageFromCause(cause);
              void publishRuntimeEvent({
                type: "runtime.error",
                eventId: nextEventId(),
                provider: PROVIDER,
                providerInstanceId,
                threadId: input.threadId,
                turnId,
                createdAt: nowIso(),
                payload: {
                  class: "provider_error",
                  message: errorMessage,
                  detail: summarizeUnknown(cause),
                },
              });
            } finally {
              context.resumeCursor = buildPiResumeCursor(context);
              context.turns.push({
                id: turnId,
                items: context.session.messages.slice(turnStartMessageCount),
              });
              context.providerSession = {
                ...context.providerSession,
                status: "ready",
                activeTurnId: undefined,
                resumeCursor: context.resumeCursor,
                updatedAt: nowIso(),
                ...(errorMessage ? { lastError: errorMessage } : {}),
              };
              if (context.activeTurnId === turnId) {
                context.activeTurnId = undefined;
              }
              void publishRuntimeEvent({
                type: "turn.completed",
                eventId: nextEventId(),
                provider: PROVIDER,
                providerInstanceId,
                threadId: input.threadId,
                turnId,
                createdAt: nowIso(),
                payload: {
                  state: completionState,
                  ...(errorMessage ? { errorMessage } : {}),
                },
              });
              void publishRuntimeEvent({
                type: "session.state.changed",
                eventId: nextEventId(),
                provider: PROVIDER,
                providerInstanceId,
                threadId: input.threadId,
                turnId,
                createdAt: nowIso(),
                payload: { state: "ready" },
              });
            }
          };

          void runTurn();

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: context.resumeCursor,
          };
        } catch (cause) {
          return yield* toAdapterError(PROVIDER, input.threadId, "session/prompt", cause);
        }
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        try {
          const interruptedTurnId = context.activeTurnId;
          yield* Effect.promise(() => context.session.abort());
          context.activeTurnId = undefined;
          context.providerSession = {
            ...context.providerSession,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: nowIso(),
          };
          if (interruptedTurnId) {
            yield* offerRuntimeEvent({
              type: "turn.aborted",
              eventId: nextEventId(),
              provider: PROVIDER,
              providerInstanceId,
              threadId,
              turnId: interruptedTurnId,
              createdAt: nowIso(),
              payload: { reason: "Interrupted by user." },
            });
          }
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            eventId: nextEventId(),
            provider: PROVIDER,
            providerInstanceId,
            threadId,
            ...(interruptedTurnId ? { turnId: interruptedTurnId } : {}),
            createdAt: nowIso(),
            payload: { state: "ready" },
          });
        } catch (cause) {
          return yield* toAdapterError(PROVIDER, threadId, "session/abort", cause);
        }
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "request/respond",
          detail: "Pi does not use T3 approval requests.",
        }),
      );

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const bridge = context.extensionUiBridge;
        if (!bridge) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/respondToUserInput",
            detail: "Pi extension UI bridge is not available for this session.",
          });
        }
        yield* Effect.tryPromise({
          try: () => bridge.respond(requestId, answers),
          catch: (cause) =>
            toAdapterError(PROVIDER, threadId, "item/tool/respondToUserInput", cause),
        });
        yield* offerRuntimeEvent({
          ...makeContextEventBase(context, context.activeTurnId),
          type: "user-input.resolved",
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        });
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.extensionUiBridge?.dispose();
        context.unsubscribe();
        context.session.dispose();
        sessions.delete(threadId);
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return {
          threadId,
          turns: [...context.turns],
        };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (numTurns <= 0) {
          return { threadId, turns: [...context.turns] };
        }
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue:
            "Pi rollback requires session-tree navigation and is not available for this build.",
        });
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.succeed([...sessions.values()].map((context) => context.providerSession)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread,
      rollbackThread,
      stopAll: () =>
        Effect.sync(() => {
          for (const context of sessions.values()) {
            context.unsubscribe();
            context.session.dispose();
          }
          sessions.clear();
        }),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
