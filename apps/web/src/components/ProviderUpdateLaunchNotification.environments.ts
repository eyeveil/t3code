import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { ServerConfig } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import {
  buildLocalEnvironmentUpdateGroups,
  deriveEnvironmentDisplayLabel,
  parseWslDistroFromInstanceId,
  type EnvironmentUpdateConnectionState,
  type LocalEnvironmentProvidersInput,
  type LocalEnvironmentUpdateGroup,
} from "./ProviderUpdateLaunchNotification.logic";

/**
 * A local environment is either the same-origin primary backend or a
 * desktop-local secondary (the parallel WSL backend), which connects over
 * loopback with a bearer token and carries a `local:<environmentId>`
 * connection id. SSH, relay, and other remote targets are excluded.
 */
function isLocalConnectionTarget(target: ConnectionCatalogEntry["target"]): boolean {
  return (
    target._tag === "PrimaryConnectionTarget" ||
    (target._tag === "BearerConnectionTarget" && target.connectionId.startsWith("local:"))
  );
}

function normalizeConnectionState(
  phase: string | undefined,
): EnvironmentUpdateConnectionState {
  switch (phase) {
    case "connected":
      return "ready";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "error":
      return "error";
    case "offline":
      return "disconnected";
    default:
      // "available" (or anything not yet observed) — the backend has not
      // confirmed it is serving yet, so treat it as still settling so the
      // popover waits for it.
      return "connecting";
  }
}

/**
 * The stable backend instance id of a desktop-local secondary (e.g.
 * "wsl:ubuntu"), recovered from the desktop bootstrap topology by matching the
 * environment's loopback URL. Used only to derive the WSL distro label; absence
 * is fine because labeling falls back to the reported platform OS.
 */
function localBackendInstanceId(displayUrl: string | null): string | undefined {
  if (displayUrl === null) {
    return undefined;
  }
  try {
    const bootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
    const match = bootstraps.find((entry) => entry.httpBaseUrl === displayUrl);
    return match?.id;
  } catch {
    return undefined;
  }
}

/**
 * Reactively enumerate the enabled local environments (the primary plus any
 * desktop-local secondary such as WSL) with each one's full provider list and a
 * flag for whether any is still connecting. Drives the launch popover's gating
 * and its per-environment update triggers.
 */
export function useLocalEnvironmentUpdateGroups(): {
  readonly groups: LocalEnvironmentUpdateGroup[];
  readonly isAnySettling: boolean;
} {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  return useMemo(() => {
    const inputs: LocalEnvironmentProvidersInput[] = [];

    for (const environment of environments) {
      if (!isLocalConnectionTarget(environment.entry.target)) {
        continue;
      }

      const isPrimary = environment.environmentId === primaryEnvironmentId;
      const serverConfig: ServerConfig | null = environment.serverConfig;
      const instanceId = isPrimary
        ? undefined
        : localBackendInstanceId(environment.displayUrl);
      const wslDistro = parseWslDistroFromInstanceId(instanceId);

      inputs.push({
        environmentId: environment.environmentId,
        // Label by platform so the row reads "Windows"/"WSL", not the account name.
        label: deriveEnvironmentDisplayLabel({
          isWsl: instanceId?.startsWith("wsl:") === true,
          wslDistro,
          platformOs: serverConfig?.environment.platform.os,
          fallbackLabel: environment.label,
        }),
        isPrimary,
        // The primary is the backend serving this renderer, so it is ready
        // whenever its providers are available; secondaries report their live
        // connection phase.
        connectionState: isPrimary
          ? "ready"
          : normalizeConnectionState(environment.connection.phase),
        providers: serverConfig?.providers ?? [],
      });
    }

    // Primary first, then the rest in catalog order.
    inputs.sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));

    return buildLocalEnvironmentUpdateGroups(inputs);
  }, [environments, primaryEnvironmentId]);
}
