import { describe, expect, it } from "@effect/vitest";

import {
  resolveEndScrollMaintenance,
  shouldArmSendAnchorAnimation,
} from "./threadScrollMaintenance";

describe("thread scroll maintenance", () => {
  describe("shouldArmSendAnchorAnimation", () => {
    it("arms when a new send anchor appears", () => {
      expect(shouldArmSendAnchorAnimation(null, "msg-1")).toBe(true);
    });

    it("arms when the anchor changes to a different message", () => {
      expect(shouldArmSendAnchorAnimation("msg-1", "msg-2")).toBe(true);
    });

    it("does not re-arm for the same anchor across streamed frames", () => {
      expect(shouldArmSendAnchorAnimation("msg-1", "msg-1")).toBe(false);
    });

    it("does not arm when the anchor clears on thread switch", () => {
      expect(shouldArmSendAnchorAnimation("msg-1", null)).toBe(false);
    });

    it("does not arm when there is no anchor at all", () => {
      expect(shouldArmSendAnchorAnimation(null, null)).toBe(false);
    });
  });

  describe("resolveEndScrollMaintenance", () => {
    it("suspends end pinning while a disclosure toggle settles", () => {
      expect(
        resolveEndScrollMaintenance({
          disclosureToggleSettling: true,
          sendAnchorAnimating: false,
        }),
      ).toBe(false);
    });

    it("suspends end pinning during a disclosure settle even mid send window", () => {
      expect(
        resolveEndScrollMaintenance({
          disclosureToggleSettling: true,
          sendAnchorAnimating: true,
        }),
      ).toBe(false);
    });

    it("pins instantly during streaming so the feed cannot oscillate", () => {
      expect(
        resolveEndScrollMaintenance({
          disclosureToggleSettling: false,
          sendAnchorAnimating: false,
        }),
      ).toEqual({
        animated: false,
        on: { dataChange: true, itemLayout: true, layout: true },
      });
    });

    it("pins with animation only inside the post-send window", () => {
      expect(
        resolveEndScrollMaintenance({
          disclosureToggleSettling: false,
          sendAnchorAnimating: true,
        }),
      ).toEqual({
        animated: true,
        on: { dataChange: true, itemLayout: true, layout: true },
      });
    });
  });
});
