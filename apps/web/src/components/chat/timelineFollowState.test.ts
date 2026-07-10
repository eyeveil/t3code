import { describe, expect, it } from "vite-plus/test";
import {
  FOLLOW_SCROLL_UP_EPSILON,
  resolveFollowScrollAction,
  type FollowScrollSample,
} from "./timelineFollowState";

function sample(overrides: Partial<FollowScrollSample> = {}): FollowScrollSample {
  return {
    scroll: 1000,
    previousScroll: 1000,
    isAtBottom: true,
    isProgrammatic: false,
    following: true,
    ...overrides,
  };
}

describe("timeline follow-state machine", () => {
  it("keeps following while content grows below (scrollTop unchanged, off bottom)", () => {
    // Streaming appends below the viewport: scrollTop stays put even though the
    // list is momentarily reported as not-at-bottom before we re-pin.
    expect(
      resolveFollowScrollAction(sample({ scroll: 1000, previousScroll: 1000, isAtBottom: false })),
    ).toBe("none");
  });

  it("breaks following when the user scrolls up away from the bottom", () => {
    expect(
      resolveFollowScrollAction(sample({ scroll: 600, previousScroll: 1000, isAtBottom: false })),
    ).toBe("break");
  });

  it("ignores tiny upward jitter within the epsilon", () => {
    expect(
      resolveFollowScrollAction(
        sample({
          scroll: 1000 - (FOLLOW_SCROLL_UP_EPSILON - 1),
          previousScroll: 1000,
          isAtBottom: false,
        }),
      ),
    ).toBe("none");
  });

  it("does not break when a small scroll-up stays within the bottom threshold", () => {
    // Still effectively at the bottom — no reason to stop following.
    expect(
      resolveFollowScrollAction(sample({ scroll: 990, previousScroll: 1000, isAtBottom: true })),
    ).toBe("none");
  });

  it("never reacts to our own programmatic scrolls", () => {
    // An anchor scroll that jumps upward must not be read as a user scroll-up.
    expect(
      resolveFollowScrollAction(
        sample({
          scroll: 200,
          previousScroll: 1000,
          isAtBottom: false,
          isProgrammatic: true,
        }),
      ),
    ).toBe("none");
  });

  it("resumes following when the user returns to the bottom", () => {
    expect(
      resolveFollowScrollAction(
        sample({
          scroll: 1000,
          previousScroll: 600,
          isAtBottom: true,
          following: false,
        }),
      ),
    ).toBe("resume");
  });

  it("stays unfollowed while the user reads above the bottom", () => {
    expect(
      resolveFollowScrollAction(
        sample({
          scroll: 400,
          previousScroll: 600,
          isAtBottom: false,
          following: false,
        }),
      ),
    ).toBe("none");
  });

  it("does not resume from a programmatic scroll that lands at the bottom", () => {
    expect(
      resolveFollowScrollAction(
        sample({
          scroll: 1000,
          previousScroll: 600,
          isAtBottom: true,
          following: false,
          isProgrammatic: true,
        }),
      ),
    ).toBe("none");
  });

  it("treats the first sample (no previous scroll) as no-op when off bottom", () => {
    expect(
      resolveFollowScrollAction(sample({ scroll: 500, previousScroll: null, isAtBottom: false })),
    ).toBe("none");
  });
});
