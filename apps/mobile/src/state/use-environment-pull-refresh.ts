import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { useAtomCommand } from "./use-atom-command";

const SETTLE_POLL_MS = 250;
const SETTLE_TIMEOUT_MS = 8_000;
// retryNow only enqueues a supervisor signal; the phase flips to
// connecting/reconnecting asynchronously. Without this grace the settle poll
// can read the stale "connected" phase and hide the spinner immediately.
const RETRY_GRACE_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function environmentSettled(environmentId: EnvironmentId): boolean {
  const presentation = appAtomRegistry.get(
    environmentPresentations.presentationAtom(environmentId),
  );
  const phase = presentation?.connection.phase;
  return phase !== "connecting" && phase !== "reconnecting";
}

/**
 * Deterministic pull-to-refresh over environment connections. All state is
 * server-pushed, so "refresh" = the app's existing manual resync action
 * (`retryNow`, as used by the composer connection pill): drop the lease,
 * reconnect, and pull a fresh shell snapshot. The spinner tracks the
 * reconnect until every environment's phase settles, with a bounded wait so
 * an unreachable environment cannot pin the spinner.
 */
export function useEnvironmentPullRefresh(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly isRefreshing: boolean;
  readonly onRefresh: () => Promise<void>;
} {
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, {
    label: "environment pull refresh",
    reportFailure: false,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Ref keeps onRefresh stable across renders that rebuild the ids array.
  const environmentIdsRef = useRef(environmentIds);
  environmentIdsRef.current = environmentIds;

  const onRefresh = useCallback(async () => {
    const ids = environmentIdsRef.current;
    setIsRefreshing(true);
    try {
      await Promise.all(ids.map((environmentId) => retryEnvironment(environmentId)));
      await sleep(RETRY_GRACE_MS);
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      while (Date.now() < deadline && !ids.every(environmentSettled)) {
        await sleep(SETTLE_POLL_MS);
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [retryEnvironment]);

  return { isRefreshing, onRefresh };
}
