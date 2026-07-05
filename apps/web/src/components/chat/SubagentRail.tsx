import { memo, useEffect, useRef } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatDuration, type SubagentRailItem } from "../../session-logic";

/**
 * Floating live overview of the running turn's subagents (collab agent tool
 * calls) — name, status, and elapsed time, omp/codex style. Overlays the
 * timeline's top-right corner; hidden on narrow viewports where it would
 * cover message content.
 */
export const SubagentRail = memo(function SubagentRail({
  items,
}: {
  items: ReadonlyArray<SubagentRailItem>;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <aside
      aria-label="Subagents"
      className="pointer-events-none absolute top-2 right-3 z-10 hidden w-60 lg:block"
    >
      <div className="pointer-events-auto rounded-lg border border-border/60 bg-background/85 shadow-sm backdrop-blur">
        <p className="px-2.5 pt-2 pb-1 font-medium text-[11px] text-muted-foreground/65">
          Subagents
        </p>
        <ul className="max-h-64 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
          {items.map((item) => (
            <li
              key={item.id}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] leading-5",
                item.status !== "running" && "opacity-60",
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {item.status === "running" ? (
                  <span
                    className="block size-2 animate-pulse rounded-full bg-muted-foreground/60"
                    aria-label="Running"
                  />
                ) : item.status === "failed" ? (
                  <XIcon className="block size-3 text-destructive" aria-label="Failed" />
                ) : (
                  <CheckIcon
                    className="block size-3 text-muted-foreground/70"
                    aria-label="Completed"
                  />
                )}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-medium text-foreground/82"
                title={item.detail ?? item.name}
              >
                {item.name}
              </span>
              {item.status === "running" ? <SubagentElapsed startedAt={item.createdAt} /> : null}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
});

/** Self-ticking elapsed label — avoids a React commit per second (same pattern as WorkingTimer). */
function SubagentElapsed({ startedAt }: { startedAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatElapsedSince(startedAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <span ref={textRef} className="shrink-0 text-[11px] text-muted-foreground/55 tabular-nums">
      {formatElapsedSince(startedAt)}
    </span>
  );
}

function formatElapsedSince(startedAt: string): string {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return "";
  }
  return formatDuration(Math.max(0, Date.now() - startedMs));
}
