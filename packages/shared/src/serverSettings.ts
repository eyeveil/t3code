import {
  type ProviderInstanceConfig,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";

/**
 * Driver kinds whose per-instance config carries a `homePath` that isolates
 * the underlying CLI's state (CODEX_HOME for codex, HOME override for claude).
 * Only these drivers get an auto-generated isolated home for newly-created
 * instances; every other driver keeps its config verbatim.
 */
export const PROVIDER_DRIVERS_WITH_ISOLATED_HOME: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
]);

function providerInstanceHomePathIsEmpty(config: unknown): boolean {
  if (config === null || typeof config !== "object") {
    return true;
  }
  const homePath = (config as { readonly homePath?: unknown }).homePath;
  return typeof homePath !== "string" || homePath.trim().length === 0;
}

/**
 * Inject a default isolated `homePath` into every provider instance that is
 * *newly* present in `nextInstances` (absent from `currentInstances`), is not a
 * bare driver-default id (`instanceId !== driver`), uses a driver that supports
 * an isolated home, and does not already declare a non-empty `homePath`.
 *
 * Backward compatible by construction: existing instances (including the bare
 * driver ids like `codex` / `claudeAgent`) are never touched, so their shared
 * default-home behaviour is preserved exactly.
 *
 * `computeHome` maps an instance id to its absolute home path — kept as a
 * callback so path joining stays with the caller that owns the server paths.
 * Returns the same reference when nothing changed.
 */
export function withDefaultProviderInstanceHomes(
  currentInstances: ServerSettings["providerInstances"] | undefined,
  nextInstances: ServerSettings["providerInstances"],
  computeHome: (instanceId: string) => string,
): ServerSettings["providerInstances"] {
  let changed = false;
  const result: Record<string, ProviderInstanceConfig> = { ...nextInstances };
  for (const [instanceId, envelope] of Object.entries(nextInstances)) {
    if (currentInstances && instanceId in currentInstances) {
      continue; // pre-existing instance — keep its config verbatim
    }
    if (instanceId === envelope.driver) {
      continue; // bare driver-default id — preserve legacy shared-home behaviour
    }
    if (!PROVIDER_DRIVERS_WITH_ISOLATED_HOME.has(envelope.driver)) {
      continue;
    }
    if (!providerInstanceHomePathIsEmpty(envelope.config)) {
      continue; // user (or an earlier persist) already chose a home
    }
    const existingConfig =
      envelope.config !== null && typeof envelope.config === "object"
        ? (envelope.config as Record<string, unknown>)
        : {};
    result[instanceId] = {
      ...envelope,
      config: { ...existingConfig, homePath: computeHome(instanceId) },
    };
    changed = true;
  }
  return changed ? (result as ServerSettings["providerInstances"]) : nextInstances;
}

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

/**
 * Applies a server settings patch while treating textGenerationModelSelection as
 * replace-on-provider/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const { automaticGitFetchInterval, ...patchForMerge } = patch;
  const next = deepMerge(current, patchForMerge);
  const nextWithReplacements = {
    ...next,
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
