import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderLoginCancelInput,
  ProviderLoginResizeInput,
  ProviderLoginStartInput,
  ProviderLoginStreamEvent,
  ProviderLoginWriteInput,
} from "./providerLogin.ts";

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("ProviderLoginStartInput", () => {
  it("decodes a minimal payload", () => {
    expect(decodes(ProviderLoginStartInput, { instanceId: "codex_work" })).toBe(true);
  });

  it("decodes optional cols/rows", () => {
    expect(
      decodes(ProviderLoginStartInput, { instanceId: "codex_work", cols: 120, rows: 40 }),
    ).toBe(true);
  });

  it("rejects an empty instanceId", () => {
    expect(decodes(ProviderLoginStartInput, { instanceId: "" })).toBe(false);
  });

  it("rejects out-of-range cols", () => {
    expect(decodes(ProviderLoginStartInput, { instanceId: "codex_work", cols: 5000 })).toBe(false);
  });
});

describe("ProviderLoginWriteInput / ResizeInput / CancelInput", () => {
  it("decodes a write", () => {
    expect(decodes(ProviderLoginWriteInput, { instanceId: "codex_work", data: "y\r" })).toBe(true);
  });

  it("rejects an empty write", () => {
    expect(decodes(ProviderLoginWriteInput, { instanceId: "codex_work", data: "" })).toBe(false);
  });

  it("decodes a resize", () => {
    expect(
      decodes(ProviderLoginResizeInput, { instanceId: "codex_work", cols: 80, rows: 24 }),
    ).toBe(true);
  });

  it("decodes a cancel", () => {
    expect(decodes(ProviderLoginCancelInput, { instanceId: "codex_work" })).toBe(true);
  });
});

describe("ProviderLoginStreamEvent", () => {
  it("decodes each variant", () => {
    expect(
      decodes(ProviderLoginStreamEvent, {
        type: "started",
        instanceId: "codex_work",
        driver: "codex",
        commandLabel: "codex login --device-auth",
      }),
    ).toBe(true);
    expect(decodes(ProviderLoginStreamEvent, { type: "output", data: "hello" })).toBe(true);
    expect(
      decodes(ProviderLoginStreamEvent, { type: "exited", exitCode: 0, exitSignal: null }),
    ).toBe(true);
    expect(decodes(ProviderLoginStreamEvent, { type: "error", message: "boom" })).toBe(true);
  });

  it("rejects an unknown variant", () => {
    expect(decodes(ProviderLoginStreamEvent, { type: "nope" })).toBe(false);
  });
});
