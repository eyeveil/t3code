import { describe, expect, it } from "vite-plus/test";

import {
  describeFallbackRejections,
  selectFallbackCandidate,
  type FallbackCandidateInstance,
  type FallbackCandidateSnapshot,
} from "./candidates.ts";

const instance = (
  instanceId: string,
  overrides: Partial<FallbackCandidateInstance> = {},
): FallbackCandidateInstance => ({
  instanceId,
  driver: "codex",
  ...overrides,
});

const snapshot = (
  instanceId: string,
  overrides: Partial<FallbackCandidateSnapshot> = {},
): [string, FallbackCandidateSnapshot] => [
  instanceId,
  {
    instanceId,
    enabled: true,
    available: true,
    authStatus: "authenticated",
    modelSlugs: ["gpt-5-codex", "gpt-5.5"],
    ...overrides,
  },
];

const baseInput = {
  failedInstanceId: "codex",
  driver: "codex",
  requiredModel: "gpt-5-codex",
  attemptedInstanceIds: new Set<string>(["codex"]),
  isCoolingDown: () => false,
};

describe("selectFallbackCandidate", () => {
  it("picks the first eligible sibling in settings order", () => {
    const { candidate } = selectFallbackCandidate({
      ...baseInput,
      instances: [instance("codex"), instance("codex-b"), instance("codex-a")],
      snapshots: new Map([snapshot("codex"), snapshot("codex-b"), snapshot("codex-a")]),
    });
    expect(candidate?.instanceId).toBe("codex-b");
  });

  it("skips disabled, unavailable, and unauthenticated instances", () => {
    const { candidate, rejections } = selectFallbackCandidate({
      ...baseInput,
      instances: [
        instance("codex"),
        instance("codex-disabled"),
        instance("codex-unavailable"),
        instance("codex-noauth"),
        instance("codex-ok"),
      ],
      snapshots: new Map([
        snapshot("codex"),
        snapshot("codex-disabled", { enabled: false }),
        snapshot("codex-unavailable", { available: false }),
        snapshot("codex-noauth", { authStatus: "unauthenticated" }),
        snapshot("codex-ok"),
      ]),
    });
    expect(candidate?.instanceId).toBe("codex-ok");
    expect(rejections).toContainEqual({
      instanceId: "codex-disabled",
      reason: "not-configured-enabled",
    });
    expect(rejections).toContainEqual({
      instanceId: "codex-noauth",
      reason: "not-authenticated",
    });
  });

  it("skips instances without a live snapshot", () => {
    const { candidate } = selectFallbackCandidate({
      ...baseInput,
      instances: [instance("codex"), instance("codex-ghost")],
      snapshots: new Map([snapshot("codex")]),
    });
    expect(candidate).toBeNull();
  });

  it("skips instances that opted out of fallback", () => {
    const { candidate, rejections } = selectFallbackCandidate({
      ...baseInput,
      instances: [instance("codex"), instance("codex-optout", { participateInFallback: false })],
      snapshots: new Map([snapshot("codex"), snapshot("codex-optout")]),
    });
    expect(candidate).toBeNull();
    expect(rejections).toContainEqual({ instanceId: "codex-optout", reason: "opted-out" });
  });

  it("skips instances inside a limit cooldown", () => {
    const { candidate, rejections } = selectFallbackCandidate({
      ...baseInput,
      instances: [instance("codex"), instance("codex-cooling"), instance("codex-fresh")],
      snapshots: new Map([snapshot("codex"), snapshot("codex-cooling"), snapshot("codex-fresh")]),
      isCoolingDown: (instanceId) => instanceId === "codex-cooling",
    });
    expect(candidate?.instanceId).toBe("codex-fresh");
    expect(rejections).toContainEqual({ instanceId: "codex-cooling", reason: "cooling-down" });
  });

  it("skips instances already attempted this turn", () => {
    const { candidate } = selectFallbackCandidate({
      ...baseInput,
      attemptedInstanceIds: new Set(["codex", "codex-b"]),
      instances: [instance("codex"), instance("codex-b"), instance("codex-c")],
      snapshots: new Map([snapshot("codex"), snapshot("codex-b"), snapshot("codex-c")]),
    });
    expect(candidate?.instanceId).toBe("codex-c");
  });

  it("never selects across drivers", () => {
    const { candidate } = selectFallbackCandidate({
      ...baseInput,
      instances: [instance("codex"), instance("claude-2", { driver: "claudeAgent" })],
      snapshots: new Map([snapshot("codex"), snapshot("claude-2")]),
    });
    expect(candidate).toBeNull();
  });

  it("refuses instances that do not resolve the exact model (fidelity gate)", () => {
    const { candidate, rejections } = selectFallbackCandidate({
      ...baseInput,
      requiredModel: "my-custom-model",
      instances: [instance("codex"), instance("codex-plain"), instance("codex-custom")],
      snapshots: new Map([
        snapshot("codex", { modelSlugs: ["my-custom-model", "gpt-5-codex"] }),
        snapshot("codex-plain", { modelSlugs: ["gpt-5-codex"] }),
        snapshot("codex-custom", { modelSlugs: ["gpt-5-codex", "my-custom-model"] }),
      ]),
    });
    expect(candidate?.instanceId).toBe("codex-custom");
    expect(rejections).toContainEqual({
      instanceId: "codex-plain",
      reason: "model-unresolvable",
    });
  });

  it("returns null with a describable rejection list when nothing is eligible", () => {
    const { candidate, rejections } = selectFallbackCandidate({
      ...baseInput,
      instances: [instance("codex")],
      snapshots: new Map([snapshot("codex")]),
    });
    expect(candidate).toBeNull();
    expect(describeFallbackRejections(rejections)).toBe(
      "no other instances of this provider are configured",
    );
  });
});
