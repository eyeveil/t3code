// @effect-diagnostics nodeBuiltinImport:off - Loads the same CommonJS config Expo uses.
import * as NodeModule from "node:module";
import { expect, it, vi } from "vite-plus/test";

it.each([
  { version: undefined, major: "2" },
  { version: "0.10.0", major: "0" },
  { version: "3.0.0", major: "3" },
  { version: "3.1.0", major: "3" },
])("fingerprints the effective app major for $version", ({ version, major }) => {
  const require = NodeModule.createRequire(import.meta.url);
  const configPath = require.resolve("../fingerprint.config.js");
  vi.stubEnv("T3CODE_MOBILE_VERSION", version);
  delete require.cache[configPath];
  try {
    expect(require(configPath)).toEqual({
      extraSources: [{ type: "contents", id: "appMajorVersion", contents: major }],
    });
  } finally {
    vi.unstubAllEnvs();
    delete require.cache[configPath];
  }
});
