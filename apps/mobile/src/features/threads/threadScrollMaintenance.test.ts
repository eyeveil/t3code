import { describe, expect, it } from "@effect/vitest";

import {
  deriveJumpToBottomState,
  distanceFromEndForScrollEvent,
  FOLLOW_RELEASE_THRESHOLD_PX,
  FOLLOW_RESUME_THRESHOLD_PX,
  nextFollowStream,
  nextNewActivityWhileAway,
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
    it("hands the list no end-pin while the reader has scrolled up", () => {
      expect(
        resolveEndScrollMaintenance({
          followingStream: false,
          disclosureToggleSettling: false,
          sendAnchorAnimating: false,
        }),
      ).toBe(false);
    });

    it("stays unpinned when scrolled up even inside the post-send window", () => {
      expect(
        resolveEndScrollMaintenance({
          followingStream: false,
          disclosureToggleSettling: false,
          sendAnchorAnimating: true,
        }),
      ).toBe(false);
    });

    it("suspends end pinning while a disclosure toggle settles", () => {
      expect(
        resolveEndScrollMaintenance({
          followingStream: true,
          disclosureToggleSettling: true,
          sendAnchorAnimating: false,
        }),
      ).toBe(false);
    });

    it("suspends end pinning during a disclosure settle even mid send window", () => {
      expect(
        resolveEndScrollMaintenance({
          followingStream: true,
          disclosureToggleSettling: true,
          sendAnchorAnimating: true,
        }),
      ).toBe(false);
    });

    it("pins instantly during streaming so the feed cannot oscillate", () => {
      expect(
        resolveEndScrollMaintenance({
          followingStream: true,
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
          followingStream: true,
          disclosureToggleSettling: false,
          sendAnchorAnimating: true,
        }),
      ).toEqual({
        animated: true,
        on: { dataChange: true, itemLayout: true, layout: true },
      });
    });
  });

  describe("distanceFromEndForScrollEvent", () => {
    it("reads ~0 at the resting bottom on Android (no bottom inset)", () => {
      expect(
        distanceFromEndForScrollEvent({
          contentSize: { height: 2000 },
          contentOffset: { y: 1200 },
          layoutMeasurement: { height: 800 },
        }),
      ).toBe(0);
    });

    it("folds the iOS bottom composer inset back in so the bottom reads ~0", () => {
      // At rest at the bottom on iOS the offset overshoots content by the inset.
      expect(
        distanceFromEndForScrollEvent({
          contentSize: { height: 2000 },
          contentOffset: { y: 1320 },
          layoutMeasurement: { height: 800 },
          contentInset: { bottom: 120 },
        }),
      ).toBe(0);
    });

    it("grows positive as the user scrolls up", () => {
      expect(
        distanceFromEndForScrollEvent({
          contentSize: { height: 2000 },
          contentOffset: { y: 900 },
          layoutMeasurement: { height: 800 },
        }),
      ).toBe(300);
    });
  });

  describe("nextFollowStream", () => {
    it("resumes following once back within the resume threshold", () => {
      expect(
        nextFollowStream(false, {
          distanceFromEnd: FOLLOW_RESUME_THRESHOLD_PX,
          isUserScroll: true,
        }),
      ).toBe(true);
    });

    it("resumes when scrolled to the bottom programmatically (not a user scroll)", () => {
      expect(nextFollowStream(false, { distanceFromEnd: 0, isUserScroll: false })).toBe(true);
    });

    it("breaks follow when the user scrolls past the release threshold", () => {
      expect(
        nextFollowStream(true, {
          distanceFromEnd: FOLLOW_RELEASE_THRESHOLD_PX + 1,
          isUserScroll: true,
        }),
      ).toBe(false);
    });

    it("a programmatic scroll away from the bottom never breaks follow", () => {
      expect(
        nextFollowStream(true, {
          distanceFromEnd: FOLLOW_RELEASE_THRESHOLD_PX + 500,
          isUserScroll: false,
        }),
      ).toBe(true);
    });

    it("holds state inside the hysteresis band", () => {
      const mid = (FOLLOW_RESUME_THRESHOLD_PX + FOLLOW_RELEASE_THRESHOLD_PX) / 2;
      expect(nextFollowStream(true, { distanceFromEnd: mid, isUserScroll: true })).toBe(true);
      expect(nextFollowStream(false, { distanceFromEnd: mid, isUserScroll: true })).toBe(false);
    });
  });

  describe("deriveJumpToBottomState", () => {
    it("hides the arrow while following the stream", () => {
      expect(
        deriveJumpToBottomState({ followingStream: true, hasNewActivityWhileAway: false }),
      ).toEqual({ visible: false, showNewActivityDot: false });
    });

    it("shows the arrow once the reader has scrolled away", () => {
      expect(
        deriveJumpToBottomState({ followingStream: false, hasNewActivityWhileAway: false }),
      ).toEqual({ visible: true, showNewActivityDot: false });
    });

    it("rides the new-activity dot on the arrow while away", () => {
      expect(
        deriveJumpToBottomState({ followingStream: false, hasNewActivityWhileAway: true }),
      ).toEqual({ visible: true, showNewActivityDot: true });
    });

    it("never shows the dot when the arrow itself is hidden", () => {
      // A stale latch can't leak a dot onto a hidden arrow.
      expect(
        deriveJumpToBottomState({ followingStream: true, hasNewActivityWhileAway: true }),
      ).toEqual({ visible: false, showNewActivityDot: false });
    });
  });

  describe("nextNewActivityWhileAway", () => {
    it("latches on when the feed grows while the reader is away", () => {
      expect(
        nextNewActivityWhileAway({ current: false, followingStream: false, feedGrew: true }),
      ).toBe(true);
    });

    it("holds the latch across quiet frames while still away", () => {
      expect(
        nextNewActivityWhileAway({ current: true, followingStream: false, feedGrew: false }),
      ).toBe(true);
    });

    it("clears the latch the moment following resumes", () => {
      expect(
        nextNewActivityWhileAway({ current: true, followingStream: true, feedGrew: false }),
      ).toBe(false);
    });

    it("lets resuming follow win over a same-frame growth", () => {
      expect(
        nextNewActivityWhileAway({ current: false, followingStream: true, feedGrew: true }),
      ).toBe(false);
    });

    it("stays clear when nothing has grown and the reader is away", () => {
      expect(
        nextNewActivityWhileAway({ current: false, followingStream: false, feedGrew: false }),
      ).toBe(false);
    });
  });
});
