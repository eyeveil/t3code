// Decides how LegendList's `maintainScrollAtEnd` behaves for the thread feed.
//
// The list runs two scroll keepers at once: `maintainScrollAtEnd` (pin to the
// bottom while following a live reply) and `maintainVisibleContentPosition`
// (hold the in-view anchor still when content resizes). On native these are NOT
// coordinated while an *animated* scrollToEnd is in flight — the library only
// reconciles an in-progress animated end-scroll with MVCP on web (@legendapp/
// list changelog, #468/#463).
//
// So during streaming an animated end-scroll oscillates: every streamed token
// is a dataChange; MVCP restores the prior anchor (nudging scroll up as the last
// message grows), then `maintainScrollAtEnd` launches a ~500ms animated
// scrollToEnd (nudging down). The next token lands before that animation
// settles, re-restoring and re-scrolling — the viewport visibly jumps up and
// down on a loop. An *instant* end-scroll resolves in the same frame as the MVCP
// restore, so each frame simply renders at the end: glued, never oscillating.
//
// The one place a smooth (animated) end-scroll is wanted is right after a send:
// the optimistic user message's dataChange fires `maintainScrollAtEnd` before
// the explicit anchor scroll can run, and an instant snap there teleports rather
// than glides the feed to the anchor. That is a single discrete event, so we arm
// an animated window only for a short beat after a new send anchor appears and
// fall back to instant (streaming-safe) once it closes.

export const SEND_ANCHOR_ANIMATION_WINDOW_MS = 800;

// Sticky-scroll follow state.
//
// LegendList's own end-pin gate (`isWithinMaintainScrollAtEndThreshold`) cannot
// be trusted to hold a scrolled-up reader in place during a live turn. That flag
// is `distanceFromEnd <= maintainScrollAtEndThreshold * scrollLength` (default
// 0.1, a proportion of the viewport, ~one tenth of a screen), and `distanceFromEnd`
// is measured against the list's *anchored end space*: the trailing spacer we hand
// LegendList for the post-send glide (`anchoredEndSpace`) is included in the content
// size but collapses one-for-one as the reply streams in, so the reported end stays
// pinned roughly a viewport below the just-sent message and `distanceFromEnd` keeps
// reading near zero no matter how much has streamed. On top of that the flag is
// recomputed from MVCP-adjusted scroll bookkeeping on every data change, so a
// deliberate scroll-up is repeatedly overwritten back to "at end" mid-stream and the
// feed yanks to the bottom. So we derive "is the feed following the stream?"
// ourselves from the real scroll geometry and hand the list
// `maintainScrollAtEnd={false}` whenever the reader has scrolled away from the bottom.

// Within this many px of the true bottom, treat the feed as at the end and (re)follow.
export const FOLLOW_RESUME_THRESHOLD_PX = 24;
// A *user* scroll further than this from the bottom breaks follow. The gap above the
// resume threshold is hysteresis so a follow can't flap on sub-pixel jitter.
export const FOLLOW_RELEASE_THRESHOLD_PX = 72;

export interface FollowStreamSample {
  // Distance in px from the content's true bottom (<= 0 at or below the end).
  readonly distanceFromEnd: number;
  // Whether this scroll originated from a user drag/fling rather than a
  // programmatic scroll (end-pin, send glide, keyboard, remeasure).
  readonly isUserScroll: boolean;
}

// Distance from the content's true bottom for a native scroll event. On iOS the
// composer inset lives in `contentInset.bottom` (the user can scroll into it), so at
// rest at the bottom `contentSize - offset - viewport` reads `-insetBottom`; folding
// the inset back in normalises the resting distance to ~0 on both platforms (Android
// reports a zero bottom inset). Positive means scrolled up.
export function distanceFromEndForScrollEvent(event: {
  readonly contentSize: { readonly height: number };
  readonly contentOffset: { readonly y: number };
  readonly layoutMeasurement: { readonly height: number };
  readonly contentInset?: { readonly bottom?: number } | undefined;
}): number {
  const insetBottom = event.contentInset?.bottom ?? 0;
  return (
    event.contentSize.height + insetBottom - event.contentOffset.y - event.layoutMeasurement.height
  );
}

// Follow only ever breaks on a user-initiated scroll (a programmatic end-pin or send
// glide can never turn following off), and always resumes the moment the content is
// at the bottom again — regardless of who scrolled it there — so returning to the
// bottom re-arms the stream follow without any special gesture.
export function nextFollowStream(current: boolean, sample: FollowStreamSample): boolean {
  if (sample.distanceFromEnd <= FOLLOW_RESUME_THRESHOLD_PX) {
    return true;
  }
  if (sample.isUserScroll && sample.distanceFromEnd > FOLLOW_RELEASE_THRESHOLD_PX) {
    return false;
  }
  return current;
}

interface EndScrollMaintenanceTriggers {
  readonly dataChange: boolean;
  readonly itemLayout: boolean;
  readonly layout: boolean;
}

export type EndScrollMaintenance =
  | false
  | {
      readonly animated: boolean;
      readonly on: EndScrollMaintenanceTriggers;
    };

// A brand-new, non-null send anchor (a message the user just sent) should arm
// the animated end-scroll window. Re-seeing the same anchor, or clearing it on
// thread switch, must not — otherwise every streamed frame re-arms animation and
// the oscillation returns.
export function shouldArmSendAnchorAnimation(
  previousAnchorMessageId: string | null,
  nextAnchorMessageId: string | null,
): boolean {
  return nextAnchorMessageId !== null && nextAnchorMessageId !== previousAnchorMessageId;
}

export function resolveEndScrollMaintenance(params: {
  readonly followingStream: boolean;
  readonly disclosureToggleSettling: boolean;
  readonly sendAnchorAnimating: boolean;
}): EndScrollMaintenance {
  // The reader scrolled up: hand LegendList no end-pin at all so nothing —
  // streamed entries, work-log updates, row remeasurement, entrance animations —
  // can drag the feed back to the bottom until they return there themselves.
  if (!params.followingStream) {
    return false;
  }
  // Disclosure toggles (fold/work-group expand) briefly suspend end pinning so a
  // tapped row settles in place instead of yanking the feed to the bottom.
  if (params.disclosureToggleSettling) {
    return false;
  }
  return {
    animated: params.sendAnchorAnimating,
    on: {
      dataChange: true,
      itemLayout: true,
      layout: true,
    },
  };
}
