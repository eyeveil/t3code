import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

/** The card uses leftover space. It never changes the conversation's width. */
export function resolveThreadDetailsCardLayout({
  container,
  chat,
  frame,
  overlapsDetailsCard = false,
}: {
  container: { width: number; height: number };
  chat: { left: number; width: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
}) {
  const gap = 12;
  const width = Math.min(312, container.width - chat.left - chat.width - gap * 2);
  if (width < 240) return null;
  const x = container.width - width - gap;
  const densityHeight = container.height - gap * 2;
  // The player limits how tall the card's viewport is, never which controls it shows.
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(densityHeight, frame.y - gap * 2)
      : densityHeight;
  if (height < 160) return null;
  return {
    x,
    width,
    y: gap,
    height,
    densityHeight,
  } as const;
}
