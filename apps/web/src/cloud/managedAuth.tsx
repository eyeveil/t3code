import { useAuth } from "@clerk/react";
import { createManagedRelaySession, setManagedRelaySession } from "@t3tools/client-runtime";
import { RELAY_CLERK_TOKEN_OPTIONS } from "@t3tools/shared/relayAuth";
import { useEffect, type ReactNode } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";

let relayTokenProvider: (() => Promise<string | null>) | null = null;

export async function readManagedRelayClerkToken(): Promise<string | null> {
  return relayTokenProvider?.() ?? null;
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isSignedIn, userId } = useAuth();

  useEffect(() => {
    relayTokenProvider = isSignedIn ? () => getToken(RELAY_CLERK_TOKEN_OPTIONS) : null;
    setManagedRelaySession(
      appAtomRegistry,
      isSignedIn && userId
        ? createManagedRelaySession({
            accountId: userId,
            readClerkToken: () => getToken(RELAY_CLERK_TOKEN_OPTIONS),
          })
        : null,
    );
    return () => {
      relayTokenProvider = null;
      setManagedRelaySession(appAtomRegistry, null);
    };
  }, [getToken, isSignedIn, userId]);

  return children;
}
