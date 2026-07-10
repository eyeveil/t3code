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
  readonly disclosureToggleSettling: boolean;
  readonly sendAnchorAnimating: boolean;
}): EndScrollMaintenance {
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
