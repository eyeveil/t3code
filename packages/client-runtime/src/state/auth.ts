import type {
  AuthAccessSnapshot,
  AuthAccessStreamEvent,
  AuthAccessStreamSnapshotEvent,
  AuthCreatePairingCredentialInput,
  AuthSessionId,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import { Atom } from "effect/unstable/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { subscribe } from "../rpc/client.ts";
import {
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  type EnvironmentHttpAuthHeaders,
} from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

const ACCESS_REQUEST_TIMEOUT_MS = 15_000;

/** @public Required to name the error in consumers' inferred access command results. */
export class EnvironmentAccessConnectionNotReadyError extends Data.TaggedError(
  "EnvironmentAccessConnectionNotReadyError",
)<{ readonly message: string }> {}

type AuthHttpEndpoints = ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>["auth"];

/**
 * Run one `/api/auth/*` request against the environment this effect runs in,
 * with whatever credential this client holds for it (cookie, bearer, or DPoP).
 */
const requestEnvironmentAuth = <A, E, R>(
  endpoint: (urls: AuthHttpEndpoints) => string,
  request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<"auth">>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return yield* new EnvironmentAccessConnectionNotReadyError({
        message: "The environment is not connected yet.",
      });
    }
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: prepared.value,
      signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
      ),
      group: "auth",
      method: "POST",
      url: (httpBaseUrl) => endpoint(makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).auth),
      timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
      request,
    });
  });

export const EMPTY_AUTH_ACCESS_SNAPSHOT: AuthAccessSnapshot = {
  pairingLinks: [],
  clientSessions: [],
};

function upsertByKey<A>(
  values: ReadonlyArray<A>,
  next: A,
  key: (value: A) => string,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function applyAuthAccessStreamEvent(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): AuthAccessSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.payload;
    case "pairingLinkUpserted":
      return {
        ...current,
        pairingLinks: upsertByKey(current.pairingLinks, event.payload, (value) => value.id),
      };
    case "pairingLinkRemoved":
      return {
        ...current,
        pairingLinks: current.pairingLinks.filter((value) => value.id !== event.payload.id),
      };
    case "clientUpserted":
      return {
        ...current,
        clientSessions: upsertByKey(
          current.clientSessions,
          event.payload,
          (value) => value.sessionId,
        ),
      };
    case "clientRemoved":
      return {
        ...current,
        clientSessions: current.clientSessions.filter(
          (value) => value.sessionId !== event.payload.sessionId,
        ),
      };
  }
}

function projectAuthAccessSnapshot(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): readonly [AuthAccessSnapshot, ReadonlyArray<AuthAccessStreamEvent>] {
  const snapshot = applyAuthAccessStreamEvent(current, event);
  const projected: AuthAccessStreamSnapshotEvent = {
    version: 1,
    revision: event.revision,
    type: "snapshot",
    payload: snapshot,
  };
  return [snapshot, [projected]];
}

/**
 * Access management for any connected environment: the live pairing-link and
 * client-session snapshot, plus the commands that change it. Each needs the
 * access scopes on this client's session with that environment.
 */
export function createAuthEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    createPairingCredential: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-create-pairing-credential",
      execute: (input: AuthCreatePairingCredentialInput) =>
        requestEnvironmentAuth(
          (urls) => urls.pairingCredential(),
          ({ client, headers }) => client.pairingCredential({ headers, payload: input }),
        ),
    }),
    revokePairingLink: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-pairing-link",
      execute: (id: string) =>
        requestEnvironmentAuth(
          (urls) => urls.revokePairingLink(),
          ({ client, headers }) => client.revokePairingLink({ headers, payload: { id } }),
        ),
    }),
    revokeClient: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-client",
      execute: (sessionId: AuthSessionId) =>
        requestEnvironmentAuth(
          (urls) => urls.revokeClient(),
          ({ client, headers }) => client.revokeClient({ headers, payload: { sessionId } }),
        ),
    }),
    revokeOtherClients: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-other-clients",
      execute: (_input: null) =>
        requestEnvironmentAuth(
          (urls) => urls.revokeOtherClients(),
          ({ client, headers }) => client.revokeOtherClients({ headers }),
        ),
    }),
    accessChanges: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:auth-access-changes",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeAuthAccess, {}).pipe(
          Stream.mapAccum(() => EMPTY_AUTH_ACCESS_SNAPSHOT, projectAuthAccessSnapshot),
        ),
    }),
  };
}
