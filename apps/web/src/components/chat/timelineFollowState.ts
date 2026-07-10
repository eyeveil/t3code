// Follow-state machine for the chat timeline's sticky-scroll behaviour.
//
// The timeline auto-scrolls ("follows") the live edge while a reply streams so
// new tokens/tool rows stay visible. The instant the reader scrolls up, that
// following must stop — no programmatic scroll may fight them — and it must
// resume once they return to the bottom.
//
// The reliable signal for "the user scrolled up" is a DROP in scrollTop that we
// did not cause ourselves: streaming grows content *below* the viewport, which
// pushes the bottom away without moving scrollTop, whereas a wheel/drag/keyboard
// scroll-up lowers scrollTop. Comparing against our own scroll calls (flagged as
// programmatic) is what keeps the two apart — thresholds computed from "distance
// from the end" cannot, because content growth and a user scroll-up look
// identical through that lens.

/** Sub-pixel scroll jitter below which an upward delta is treated as noise. */
export const FOLLOW_SCROLL_UP_EPSILON = 4;

export interface FollowScrollSample {
  /** Current scrollTop of the list. */
  readonly scroll: number;
  /** Previously observed scrollTop, or null when this is the first sample. */
  readonly previousScroll: number | null;
  /** Whether the list is at (or within the edge epsilon of) the bottom. */
  readonly isAtBottom: boolean;
  /** True when this position change was caused by our own programmatic scroll. */
  readonly isProgrammatic: boolean;
  /** Whether the timeline is currently auto-following the live edge. */
  readonly following: boolean;
}

export type FollowScrollAction =
  /** No change to follow state. */
  | "none"
  /** The user scrolled away from the bottom; stop following. */
  | "break"
  /** The user returned to the bottom; resume following. */
  | "resume";

/**
 * Pure transition for a single scroll observation. Programmatic scrolls never
 * express user intent, so they are ignored. A genuine upward move away from the
 * bottom breaks the follow; arriving back at the bottom resumes it.
 */
export function resolveFollowScrollAction(sample: FollowScrollSample): FollowScrollAction {
  if (sample.isProgrammatic) {
    return "none";
  }

  const scrolledUp =
    sample.previousScroll !== null &&
    sample.scroll < sample.previousScroll - FOLLOW_SCROLL_UP_EPSILON;

  if (sample.following) {
    // Only a real upward move that leaves the bottom stops following. Content
    // growing below (scrollTop unchanged) must keep us glued.
    return scrolledUp && !sample.isAtBottom ? "break" : "none";
  }

  // Not following: returning to the bottom under the user's own power re-arms.
  return sample.isAtBottom ? "resume" : "none";
}
