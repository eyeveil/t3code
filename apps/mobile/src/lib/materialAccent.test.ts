import type { Material3Scheme } from "@pchmn/expo-material3-theme";
import { describe, expect, it } from "vite-plus/test";

import { resolveMaterialAccentVariables } from "./materialAccent";

const scheme = {
  primary: "#123456",
  onPrimary: "#ffffff",
  primaryContainer: "#654321",
  onPrimaryContainer: "#eeeeee",
  inversePrimary: "#abcdef",
  surfaceContainerHigh: "#222222",
  surfaceContainerHighest: "#333333",
  tertiary: "#00aa00",
  tertiaryContainer: "#005500",
} as Material3Scheme;

describe("resolveMaterialAccentVariables", () => {
  it("uses the light Material palette for action and tonal surfaces", () => {
    expect(resolveMaterialAccentVariables(scheme, "light")).toMatchObject({
      "--color-primary": "#123456",
      "--color-primary-foreground": "#ffffff",
      "--color-primary-tonal": "rgba(18, 52, 86, 0.16)",
      "--color-composer-surface": "#222222",
      "--color-menu-surface": "#333333",
      "--color-md-link": "#123456",
    });
  });

  it("uses container colors for dark-mode actions", () => {
    expect(resolveMaterialAccentVariables(scheme, "dark")).toMatchObject({
      "--color-primary": "#654321",
      "--color-primary-foreground": "#eeeeee",
      "--color-primary-tonal": "rgba(101, 67, 33, 0.24)",
      "--color-md-link": "#abcdef",
      "--color-switch-active": "#005500",
    });
  });
});
