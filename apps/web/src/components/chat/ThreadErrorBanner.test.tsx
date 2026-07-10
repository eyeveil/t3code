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
});
