import { describe, expect, it } from "vite-plus/test";

import {
  instanceResolvesModel,
  resolveMirrorPrimaryCustomModels,
  resolveTargetModelSlugs,
} from "./modelFidelity.ts";

describe("resolveMirrorPrimaryCustomModels", () => {
  it("defaults to mirroring for non-primary instances", () => {
    expect(resolveMirrorPrimaryCustomModels({ flag: undefined, isPrimary: false })).toBe(true);
  });

  it("defaults to not mirroring for the primary instance", () => {
    expect(resolveMirrorPrimaryCustomModels({ flag: undefined, isPrimary: true })).toBe(false);
  });

  it("honors an explicit flag over the default", () => {
    expect(resolveMirrorPrimaryCustomModels({ flag: false, isPrimary: false })).toBe(false);
    expect(resolveMirrorPrimaryCustomModels({ flag: true, isPrimary: true })).toBe(true);
  });
});

describe("resolveTargetModelSlugs / instanceResolvesModel", () => {
  it("unions the primary custom models when mirroring is on", () => {
    const input = {
      requiredModel: "my-custom",
      targetModelSlugs: ["gpt-5-codex"],
      primaryCustomModelSlugs: ["my-custom"],
      mirrorPrimaryCustomModels: true,
    };
    expect([...resolveTargetModelSlugs(input)].sort()).toEqual(["gpt-5-codex", "my-custom"]);
    expect(instanceResolvesModel(input)).toBe(true);
  });

  it("does not inherit primary customs when mirroring is off", () => {
    const input = {
      requiredModel: "my-custom",
      targetModelSlugs: ["gpt-5-codex"],
      primaryCustomModelSlugs: ["my-custom"],
      mirrorPrimaryCustomModels: false,
    };
    expect(instanceResolvesModel(input)).toBe(false);
  });

  it("refuses when the identical model is unresolvable anywhere", () => {
    expect(
      instanceResolvesModel({
        requiredModel: "gpt-6",
        targetModelSlugs: ["gpt-5-codex"],
        primaryCustomModelSlugs: ["my-custom"],
        mirrorPrimaryCustomModels: true,
      }),
    ).toBe(false);
  });
});
