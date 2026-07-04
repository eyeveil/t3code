import { AtomRegistry } from "effect/unstable/reactivity";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createMarkdownCodeHighlightAtomFamily,
  type MarkdownHighlightedCode,
} from "./markdownCodeHighlightState";

const highlightedTokens: MarkdownHighlightedCode = [
  [{ content: "const", color: "#c678dd", fontStyle: null }],
];

afterEach(() => {
  vi.restoreAllMocks();
  // Safety net: test bodies that install fake timers restore real ones inline,
  // but a mid-test failure must never leak a fake clock into a sibling test.
  vi.useRealTimers();
});

describe("markdownCodeHighlightState", () => {
  it("reuses the completed highlight for structurally equivalent input", async () => {
    const highlight = vi.fn(async () => highlightedTokens);
    const family = createMarkdownCodeHighlightAtomFamily({ highlight, idleTtlMs: 1_000 });
    const registry = AtomRegistry.make({ timeoutResolution: 1 });
    const input = {
      code: "const value = 1;",
      enabled: true,
      language: "ts",
      theme: "dark" as const,
    };
    const firstAtom = family(input);
    const firstUnmount = registry.mount(firstAtom);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(firstAtom))).toBe(true);
    });
    firstUnmount();

    const remountedAtom = family({ ...input });
    const secondUnmount = registry.mount(remountedAtom);

    // Data.Class cache key => a spread copy resolves to the same atom instance,
    // so the already-computed highlight is served without re-invoking Shiki.
    expect(remountedAtom).toBe(firstAtom);
    expect(AsyncResult.isSuccess(registry.get(remountedAtom))).toBe(true);
    expect(highlight).toHaveBeenCalledTimes(1);

    secondUnmount();
    registry.dispose();
  });

  it("produces a distinct atom and re-highlights when the code changes", async () => {
    const highlight = vi.fn(async () => highlightedTokens);
    const family = createMarkdownCodeHighlightAtomFamily({ highlight });
    const registry = AtomRegistry.make();
    const firstAtom = family({
      code: "const value = 1;",
      enabled: true,
      language: "ts",
      theme: "dark",
    });
    const secondAtom = family({
      code: "const value = 2;",
      enabled: true,
      language: "ts",
      theme: "dark",
    });
    const firstUnmount = registry.mount(firstAtom);
    const secondUnmount = registry.mount(secondAtom);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(firstAtom))).toBe(true);
      expect(AsyncResult.isSuccess(registry.get(secondAtom))).toBe(true);
    });

    expect(secondAtom).not.toBe(firstAtom);
    expect(highlight).toHaveBeenCalledTimes(2);

    firstUnmount();
    secondUnmount();
    registry.dispose();
  });

  it("recomputes highlighting after the idle cache entry expires", async () => {
    // The AtomRegistry evicts idle nodes off its own clock (Date.now() +
    // setTimeout) interleaved with async fiber resolution. A wall-clock sleep
    // would be a tuned-and-flaky guess, so drive a controllable clock instead:
    // faking setImmediate (the async dispatcher, looked up on globalThis per
    // call), setTimeout (the TTL sweep), and Date keeps eviction deterministic
    // while advanceTimersByTimeAsync flushes the highlight promise microtasks.
    vi.useFakeTimers({
      toFake: ["setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "Date"],
    });
    const highlight = vi.fn(async () => highlightedTokens);
    const family = createMarkdownCodeHighlightAtomFamily({ highlight, idleTtlMs: 20 });
    const registry = AtomRegistry.make({ timeoutResolution: 1 });
    const input = {
      code: "const value = 1;",
      enabled: true,
      language: "ts",
      theme: "dark" as const,
    };
    const atom = family(input);

    const firstUnmount = registry.mount(atom);
    await vi.advanceTimersByTimeAsync(5);
    expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true);
    expect(highlight).toHaveBeenCalledTimes(1);
    firstUnmount();

    // Advance well past the 20ms TTL so the registry sweeps the cached node.
    await vi.advanceTimersByTimeAsync(60);

    const secondUnmount = registry.mount(family({ ...input }));
    await vi.advanceTimersByTimeAsync(5);
    expect(highlight).toHaveBeenCalledTimes(2);
    expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true);

    secondUnmount();
    registry.dispose();
    vi.useRealTimers();
  });

  it("surfaces a highlighter rejection as a failed async result", async () => {
    const highlight = vi.fn(async () => {
      throw new Error("highlight failed");
    });
    const family = createMarkdownCodeHighlightAtomFamily({ highlight });
    const registry = AtomRegistry.make();
    const atom = family({ code: "const value = 1;", enabled: true, language: "ts", theme: "dark" });
    const unmount = registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });

    unmount();
    registry.dispose();
  });

  it("resolves disabled input to null via the default highlighter without touching Shiki", async () => {
    // Default family, no injected highlighter: enabled:false must short-circuit
    // to Promise.resolve(null) so disabled/streaming code renders as plain text
    // and never loads the real Shiki engine.
    const family = createMarkdownCodeHighlightAtomFamily();
    const registry = AtomRegistry.make({ timeoutResolution: 1 });
    const atom = family({ code: "x", enabled: false, language: "text", theme: "dark" });
    const unmount = registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true);
    });

    const result = registry.get(atom);
    expect(AsyncResult.isSuccess(result)).toBe(true);
    if (AsyncResult.isSuccess(result)) {
      expect(result.value).toBe(null);
    }

    unmount();
    registry.dispose();
  });
});
