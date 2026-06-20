import type { ContextMenuItem, LocalApi } from "@t3tools/contracts";
import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";
import * as Schema from "effect/Schema";

import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";
import { showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";

let cachedApi: LocalApi | undefined;

export class LocalBackendUnavailableError extends Schema.TaggedErrorClass<LocalBackendUnavailableError>()(
  "LocalBackendUnavailableError",
  {
    operation: Schema.Literals([
      "open-in-editor",
      "get-config",
      "refresh-providers",
      "update-provider",
      "upsert-keybinding",
      "remove-keybinding",
      "get-settings",
      "update-settings",
      "discover-source-control",
      "get-trace-diagnostics",
      "get-process-diagnostics",
      "get-process-resource-history",
      "signal-process",
    ]),
  },
) {
  override get message(): string {
    return `Local backend operation ${this.operation} is unavailable before a backend is paired.`;
  }
}

export class LocalExternalUrlOpenError extends Schema.TaggedErrorClass<LocalExternalUrlOpenError>()(
  "LocalExternalUrlOpenError",
  {
    urlHostname: Schema.NullOr(Schema.String),
    urlLength: Schema.Number,
    urlProtocol: Schema.NullOr(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unable to open an external URL for ${this.urlHostname ?? "an unknown host"} through the desktop bridge (${this.urlProtocol ?? "unknown protocol"}, input length ${this.urlLength}).`;
  }
}

export class LocalApiUnavailableError extends Schema.TaggedErrorClass<LocalApiUnavailableError>()(
  "LocalApiUnavailableError",
  {},
) {
  override get message(): string {
    return "Local API is unavailable in the server runtime.";
  }
}

function describeExternalUrl(url: string) {
  const diagnostics = getUrlDiagnostics(url);
  return {
    urlHostname: diagnostics.hostname ?? null,
    urlLength: diagnostics.inputLength,
    urlProtocol: diagnostics.protocol ?? null,
  };
}

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    shell: {
      openInEditor: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "open-in-editor" })),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          let opened: boolean;
          try {
            opened = await window.desktopBridge.openExternal(url);
          } catch (cause) {
            throw new LocalExternalUrlOpenError({
              ...describeExternalUrl(url),
              cause,
            });
          }
          if (!opened) {
            throw new LocalExternalUrlOpenError(describeExternalUrl(url));
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
    },
    server: {
      getConfig: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "get-config" })),
      refreshProviders: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "refresh-providers" })),
      updateProvider: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "update-provider" })),
      upsertKeybinding: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "upsert-keybinding" })),
      removeKeybinding: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "remove-keybinding" })),
      getSettings: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "get-settings" })),
      updateSettings: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "update-settings" })),
      discoverSourceControl: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "discover-source-control" })),
      getTraceDiagnostics: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "get-trace-diagnostics" })),
      getProcessDiagnostics: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "get-process-diagnostics" })),
      getProcessResourceHistory: () =>
        Promise.reject(
          new LocalBackendUnavailableError({ operation: "get-process-resource-history" }),
        ),
      signalProcess: () =>
        Promise.reject(new LocalBackendUnavailableError({ operation: "signal-process" })),
    },
  };
}

export function createLocalApi(): LocalApi {
  return createBrowserLocalApi();
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  if (window.nativeApi) {
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  cachedApi = createBrowserLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new LocalApiUnavailableError();
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  const { __resetClientSettingsPersistenceForTests } = await import("./hooks/useSettings");
  __resetClientSettingsPersistenceForTests();
  resetRequestLatencyStateForTests();
}
