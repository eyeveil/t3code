import {
  ClientPresentation,
  CloudSession,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  ConnectionWakeups,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { primaryEnvironmentRequestInit } from "../environments/primary/requestInit";
import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { isHostedStaticApp } from "../hostedPairing";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import { connectionStorageLayer } from "./storage";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Layer.succeed(
  Connectivity,
  Connectivity.of({
    status: Effect.sync(currentNetworkStatus),
    changes: Stream.callback((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const online = () => Queue.offerUnsafe(queue, "online");
          const offline = () => Queue.offerUnsafe(queue, "offline");
          window.addEventListener("online", online);
          window.addEventListener("offline", offline);
          return { online, offline };
        }),
        ({ online, offline }) =>
          Effect.sync(() => {
            window.removeEventListener("online", online);
            window.removeEventListener("offline", offline);
          }),
      ).pipe(Effect.asVoid),
    ),
  }),
);

const wakeupsLayer = Layer.succeed(
  ConnectionWakeups,
  ConnectionWakeups.of({
    changes: Stream.merge(
      Stream.callback<"application-active">((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = () => {
              if (document.visibilityState === "visible") {
                Queue.offerUnsafe(queue, "application-active");
              }
            };
            document.addEventListener("visibilitychange", listener);
            return listener;
          }),
          (listener) =>
            Effect.sync(() => {
              document.removeEventListener("visibilitychange", listener);
            }),
        ).pipe(Effect.asVoid),
      ),
      managedRelayAccountChanges(appAtomRegistry).pipe(
        Stream.map(() => "credentials-changed" as const),
      ),
    ),
  }),
);

function clientMetadata() {
  const desktop = window.desktopBridge !== undefined;
  const platform = navigator.platform.trim();
  return {
    label: desktop ? "T3 Code Desktop" : "T3 Code Web",
    deviceType: "desktop" as const,
    ...(platform === "" ? {} : { os: platform }),
  };
}

function sshPreparationError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.toLowerCase().includes("cancel")) {
    return new ConnectionBlockedError({
      reason: "authentication",
      message,
    });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    message: `Could not prepare the SSH environment: ${message}`,
  });
}

export const provisionDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.provisionDesktop",
)(function* (bridge: DesktopBridge, target: DesktopSshEnvironmentTarget) {
  const bootstrap = yield* Effect.tryPromise({
    try: () =>
      bridge.ensureSshEnvironment(target, {
        issuePairingToken: true,
      }),
    catch: sshPreparationError,
  });
  const pairingToken = bootstrap.pairingToken;
  if (pairingToken === null) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      message: "The SSH environment did not issue a pairing credential.",
    });
  }
  const descriptor = yield* Effect.tryPromise({
    try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
    catch: sshPreparationError,
  });
  const access = yield* Effect.tryPromise({
    try: () => bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, pairingToken),
    catch: sshPreparationError,
  });
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bootstrap,
    bearerToken: access.access_token,
  };
});

const capabilitiesLayer = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientPresentation.of({
      metadata: clientMetadata(),
      scopes: AuthStandardClientScopes,
    });
    const cloudSession = CloudSession.of({
      clerkToken: Effect.gen(function* () {
        const session = appAtomRegistry.get(managedRelaySessionAtom);
        if (session === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            message: "Sign in to T3 Cloud to connect this environment.",
          });
        }
        const token = yield* session.readClerkToken().pipe(
          Effect.mapError(
            (error) =>
              new ConnectionTransientError({
                reason: "network",
                message: error.message,
              }),
          ),
        );
        if (token === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            message: "The T3 Cloud session is unavailable.",
          });
        }
        return token;
      }),
    });
    const identity = RelayDeviceIdentity.of({
      deviceId: Effect.succeed(Option.none()),
    });
    const ssh = SshEnvironmentGateway.of({
      provision: Effect.fn("web.connectionPlatform.ssh.provision")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            message: "SSH environments are only available in the desktop app.",
          });
        }
        return yield* provisionDesktopSshEnvironment(bridge, target);
      }),
      prepare: Effect.fn("web.connectionPlatform.ssh.prepare")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            message: "SSH environments are only available in the desktop app.",
          });
        }
        const bootstrap = yield* Effect.tryPromise({
          try: () =>
            bridge.ensureSshEnvironment(input.target, {
              issuePairingToken: true,
            }),
          catch: sshPreparationError,
        });
        if (bootstrap.pairingToken === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            message: "The SSH environment did not issue a pairing credential.",
          });
        }
        const access = yield* Effect.tryPromise({
          try: () =>
            bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, bootstrap.pairingToken!),
          catch: sshPreparationError,
        });
        return {
          bootstrap,
          bearerToken: access.access_token,
        };
      }),
      disconnect: Effect.fn("web.connectionPlatform.ssh.disconnect")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return;
        }
        yield* Effect.tryPromise({
          try: () => bridge.disconnectSshEnvironment(target),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              message: `Could not disconnect the SSH environment: ${String(cause)}`,
            }),
        });
      }),
    });

    return Context.make(CloudSession, cloudSession).pipe(
      Context.add(RelayDeviceIdentity, identity),
      Context.add(ClientPresentation, presentation),
      Context.add(SshEnvironmentGateway, ssh),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* () {
  const resolved = readPrimaryEnvironmentTarget();
  if (resolved === null) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      message: "Unable to resolve the primary environment endpoint.",
    });
  }
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, primaryEnvironmentRequestInit),
    Effect.mapError(mapRemoteEnvironmentError),
  );
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

// A desktop-local secondary backend (e.g. a parallel WSL backend) lives on its
// own loopback origin, so — unlike the same-origin primary — it authenticates
// with a bearer token minted from the bootstrap credential the desktop issues.
const loadSecondaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadSecondaryConnectionRegistration",
)(function* (entry: DesktopEnvironmentBootstrap) {
  if (
    entry.httpBaseUrl === null ||
    entry.wsBaseUrl === null ||
    entry.bootstrapToken === undefined
  ) {
    return yield* new ConnectionTransientError({
      reason: "endpoint-unavailable",
      message: `Desktop-local backend ${entry.id} is not ready yet.`,
    });
  }
  const httpBaseUrl = entry.httpBaseUrl;
  const wsBaseUrl = entry.wsBaseUrl;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl,
    credential: entry.bootstrapToken,
    scopes: AuthStandardClientScopes,
    clientMetadata: clientMetadata(),
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const connectionId = `local:${descriptor.environmentId}`;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl,
      wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({ token: access.access_token }),
  });
});

// Poll cadence for the desktop bootstrap topology. There is no change event on
// the bridge, so the renderer polls; successful registrations are cached by a
// signature of their endpoint + token so a steady-state poll does no network.
const PLATFORM_POLL_INTERVAL = "3 seconds";

interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
}

function desktopSecondaryBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const bridge = window.desktopBridge;
  if (bridge === undefined) {
    return [];
  }
  try {
    return bridge
      .getLocalEnvironmentBootstraps()
      .filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
  } catch {
    return [];
  }
}

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    if (isHostedStaticApp()) {
      return PlatformConnectionSource.of({
        registrations: Stream.empty,
      });
    }
    const httpClient = yield* HttpClient.HttpClient;
    const cacheRef = yield* Ref.make(new Map<string, CachedPlatformRegistration>());

    // Resolve the full set of platform-managed environments the host currently
    // reports: the primary (same-origin cookie auth) plus any desktop-local
    // backends running alongside it (bearer auth). Reused registrations come
    // from the cache; a failed entry is skipped and retried on the next poll.
    const buildPlatformRegistrations = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const next = new Map<string, CachedPlatformRegistration>();
      const registrations: Array<PlatformConnectionRegistration> = [];

      const primaryTarget = readPrimaryEnvironmentTarget();
      if (primaryTarget !== null) {
        const signature = `primary|${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        if (cached !== undefined && cached.signature === signature) {
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cached);
          registrations.push(cached.registration);
        } else {
          const built = yield* loadPrimaryConnectionRegistration().pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not discover the primary environment.", { error }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, registration: built.value };
            next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cacheEntry);
            registrations.push(built.value);
          }
        }
      }

      for (const bootstrap of desktopSecondaryBootstraps()) {
        const signature = `${bootstrap.httpBaseUrl}|${bootstrap.wsBaseUrl}|${bootstrap.bootstrapToken ?? ""}`;
        const cached = previous.get(bootstrap.id);
        if (cached !== undefined && cached.signature === signature) {
          next.set(bootstrap.id, cached);
          registrations.push(cached.registration);
          continue;
        }
        const built = yield* loadSecondaryConnectionRegistration(bootstrap).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not connect a desktop-local backend.", {
              id: bootstrap.id,
              error,
            }),
          ),
          Effect.option,
        );
        if (Option.isSome(built)) {
          const cacheEntry = { signature, registration: built.value };
          next.set(bootstrap.id, cacheEntry);
          registrations.push(built.value);
        }
      }

      yield* Ref.set(cacheRef, next);
      return registrations as ReadonlyArray<PlatformConnectionRegistration>;
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

    return PlatformConnectionSource.of({
      registrations: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(
        Stream.mapEffect(() => buildPlatformRegistrations),
      ),
    });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      }),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, `${method} · ${environmentId}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      }),
  }),
);

export const connectionPlatformLayer = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);
