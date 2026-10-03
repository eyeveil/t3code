// @effect-diagnostics nodeBuiltinImport:off - Loads the same CommonJS config Expo uses.
import * as NodeModule from "node:module";
import { expect, it } from "vite-plus/test";

it("fingerprints the default app major when the release version supports an override", () => {
  const require = NodeModule.createRequire(import.meta.url);
  expect(require("../fingerprint.config.js")).toEqual({
    extraSources: [{ type: "contents", id: "appMajorVersion", contents: "2" }],
  });
});
