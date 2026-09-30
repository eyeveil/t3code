// @effect-diagnostics globalDate:off - Fixtures intentionally exercise ISO timestamp boundary values.
import { describe, expect, it } from "vite-plus/test";

import {
  LIMIT_COOLDOWN_MS,
  cooldownStateForInstance,
  isInstanceCoolingDown,
  pruneExpired,
  recordLimitHit,
} from "./cooldown.ts";

const T0 = 1_700_000_000_000;

describe("limit cooldown", () => {
  it("flags an instance for the constant window after a hit", () => {
    const map = recordLimitHit(new Map(), "codex", { now: T0, kind: "usage_limit" });
    expect(isInstanceCoolingDown(map, "codex", T0)).toBe(true);
    expect(isInstanceCoolingDown(map, "codex", T0 + LIMIT_COOLDOWN_MS - 1)).toBe(true);
    expect(isInstanceCoolingDown(map, "codex", T0 + LIMIT_COOLDOWN_MS)).toBe(false);
    expect(isInstanceCoolingDown(map, "codex-2", T0)).toBe(false);
  });

  it("extends the cooldown to the provider-supplied reset time when later", () => {
    const resetAt = T0 + 2 * LIMIT_COOLDOWN_MS;
    const map = recordLimitHit(new Map(), "codex", { now: T0, kind: "usage_limit", resetAt });
    expect(isInstanceCoolingDown(map, "codex", T0 + LIMIT_COOLDOWN_MS + 1)).toBe(true);
    expect(isInstanceCoolingDown(map, "codex", resetAt)).toBe(false);
  });

  it("exposes limitedUntil only when the provider surfaced a reset time", () => {
    const withReset = recordLimitHit(new Map(), "codex", {
      now: T0,
      kind: "usage_limit",
      resetAt: T0 + 60_000 + LIMIT_COOLDOWN_MS,
    });
    expect(cooldownStateForInstance(withReset, "codex", T0)).toEqual({
      recentlyLimited: true,
      limitedUntil: new Date(T0 + 60_000 + LIMIT_COOLDOWN_MS).toISOString(),
    });

    const withoutReset = recordLimitHit(new Map(), "codex", { now: T0, kind: "rate_limit" });
    expect(cooldownStateForInstance(withoutReset, "codex", T0)).toEqual({
      recentlyLimited: true,
    });
    expect(cooldownStateForInstance(withoutReset, "codex", T0 + LIMIT_COOLDOWN_MS)).toBeNull();
  });

  it("prunes expired entries and returns the same map when nothing changed", () => {
    const map = recordLimitHit(new Map(), "codex", { now: T0, kind: "usage_limit" });
    expect(pruneExpired(map, T0 + 1)).toBe(map);
    const pruned = pruneExpired(map, T0 + LIMIT_COOLDOWN_MS);
    expect(pruned).not.toBe(map);
    expect(pruned.size).toBe(0);
  });
});
