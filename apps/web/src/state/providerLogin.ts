import { createProviderLoginEnvironmentAtoms } from "@t3tools/client-runtime/state/provider-login";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerLoginEnvironment = createProviderLoginEnvironmentAtoms(connectionAtomRuntime);
