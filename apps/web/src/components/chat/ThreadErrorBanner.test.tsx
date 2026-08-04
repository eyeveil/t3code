import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

const ERROR = "You hit your usage limit for this provider.";

describe("ThreadErrorBanner", () => {
  it("renders the error text in the content column, not the icon column", () => {
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={ERROR} onDismiss={() => {}} />);

    // The description must be bucketed by Alert into the flex-1 content column.
    // Regression: when the Tooltip.Root wrapper was the direct child of Alert it
    // was mis-bucketed into the fixed size-4 icon column, squeezing the text to
    // ~2 chars per line.
    expect(markup).toContain('data-slot="alert-description"');

    const contentColumnIndex = markup.indexOf("flex-1");
    const iconColumnIndex = markup.indexOf("size-4");
    const descriptionIndex = markup.indexOf('data-slot="alert-description"');
    const errorTextIndex = markup.indexOf(ERROR);

    expect(contentColumnIndex).toBeGreaterThan(-1);
    expect(iconColumnIndex).toBeGreaterThan(-1);
    // Description + error text live after the flex-1 content wrapper opens,
    // i.e. inside the content column rather than the leading size-4 icon column.
    expect(descriptionIndex).toBeGreaterThan(contentColumnIndex);
    expect(errorTextIndex).toBeGreaterThan(contentColumnIndex);
  });

  it("keeps the line-clamp tooltip trigger around the error text", () => {
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={ERROR} onDismiss={() => {}} />);

    expect(markup).toContain("line-clamp-3");
    expect(markup).toContain('data-slot="tooltip-trigger"');
  });

  it("renders nothing when there is no error", () => {
    expect(renderToStaticMarkup(<ThreadErrorBanner error={null} />)).toBe("");
  });

  it("aligns the warning and dismiss icons with the first line of a multi-line error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).not.toContain("controlAlignment");
    expect(markup).toContain("flex gap-2 items-start");
    expect(markup).toContain("min-h-7 pt-1 sm:min-h-6 sm:pt-0.5");
    expect(markup).toContain("h-lh w-4");
    expect(markup).toContain("h-lh self-start");
  });
});
