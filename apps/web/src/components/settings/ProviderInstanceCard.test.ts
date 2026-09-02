import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

import {
  derivePrimaryUsageWindows,
  deriveProviderModelsForDisplay,
  ProviderInstanceCard,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("shows a redacted provider email in the editor header status line", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const driver = ProviderDriverKind.make("codex");
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated", email: "developer@example.com" },
      checkedAt: "2026-08-27T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };

    const markup = renderToStaticMarkup(
      createElement(ProviderInstanceCard, {
        instanceId,
        instance: { driver },
        driverOption: undefined,
        liveProvider,
        mode: "editor",
        onUpdate: () => undefined,
        hiddenModels: [],
        favoriteModels: [],
        modelOrder: [],
        onHiddenModelsChange: () => undefined,
        onFavoriteModelsChange: () => undefined,
        onModelOrderChange: () => undefined,
      }),
    );

    expect(markup).toContain("Authenticated as");
    expect(markup).toContain('aria-label="Toggle account email visibility"');
    expect(markup).toContain("blur-[2px]");
    expect(markup).not.toContain("developer@example.com");
  });
  it("surfaces a failed probe message in both the list row and the editor", () => {
    const instanceId = ProviderInstanceId.make("codex_work");
    const driver = ProviderDriverKind.make("codex");
    const message =
      "Codex app-server provider probe failed: Cannot create Codex shadow home entry 'auth.json' because '/home/me/.codex-t3/work/auth.json' already exists and is not a symlink.";
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      checkedAt: "2026-08-28T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      message,
    };
    const props = {
      instanceId,
      instance: { driver },
      driverOption: undefined,
      liveProvider,
      onUpdate: () => undefined,
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: [],
      onHiddenModelsChange: () => undefined,
      onFavoriteModelsChange: () => undefined,
      onModelOrderChange: () => undefined,
    } as const;

    for (const mode of ["list", "editor"] as const) {
      const markup = renderToStaticMarkup(createElement(ProviderInstanceCard, { ...props, mode }));
      expect(markup).toContain("Unavailable");
      expect(markup).toContain("is not a symlink");
    }
  });
});

describe("derivePrimaryUsageWindows", () => {
  const usage: ReadonlyArray<ServerProviderUsageWindow> = [
    { id: "seven_day", label: "Weekly", usedPercent: 28 },
    { id: "five_hour", label: "5h", usedPercent: 64 },
    { id: "other", label: "Other", usedPercent: 99 },
  ];

  it("keeps Codex's 5h and 7d windows in a stable display order", () => {
    expect(derivePrimaryUsageWindows("codex", usage)).toEqual([
      { id: "five_hour", label: "5h", window: usage[1] },
      { id: "seven_day", label: "7d", window: usage[0] },
    ]);
  });

  it("keeps both rows visible when telemetry has not arrived", () => {
    expect(derivePrimaryUsageWindows("codex", undefined)).toEqual([
      { id: "five_hour", label: "5h", window: undefined },
      { id: "seven_day", label: "7d", window: undefined },
    ]);
  });

  it("leaves 5h unavailable when Codex reports only a weekly window", () => {
    const weeklyOnly: ReadonlyArray<ServerProviderUsageWindow> = [
      { id: "seven_day", label: "Weekly", usedPercent: 30 },
    ];

    expect(derivePrimaryUsageWindows("codex", weeklyOnly)).toEqual([
      { id: "five_hour", label: "5h", window: undefined },
      { id: "seven_day", label: "7d", window: weeklyOnly[0] },
    ]);
  });

  it("classifies legacy positional Codex windows by label during version skew", () => {
    const legacyUsage: ReadonlyArray<ServerProviderUsageWindow> = [
      { id: "primary", label: "Weekly", usedPercent: 30 },
    ];

    expect(derivePrimaryUsageWindows("codex", legacyUsage)).toEqual([
      { id: "five_hour", label: "5h", window: undefined },
      { id: "seven_day", label: "7d", window: legacyUsage[0] },
    ]);
  });

  it("accepts both legacy Codex positions when their labels prove the durations", () => {
    const legacyUsage: ReadonlyArray<ServerProviderUsageWindow> = [
      { id: "primary", label: "5h", usedPercent: 12 },
      { id: "secondary", label: "Weekly", usedPercent: 34 },
    ];

    expect(derivePrimaryUsageWindows("codex", legacyUsage)).toEqual([
      { id: "five_hour", label: "5h", window: legacyUsage[0] },
      { id: "seven_day", label: "7d", window: legacyUsage[1] },
    ]);
  });

  it("does not invent usage rows for unsupported drivers", () => {
    expect(derivePrimaryUsageWindows("cursor", usage)).toEqual([]);
  });
});
