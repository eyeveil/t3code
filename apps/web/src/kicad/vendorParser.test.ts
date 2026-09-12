// @effect-diagnostics nodeBuiltinImport:off - Exercises the shipped worker bundle in an isolated VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";

const assets = new URL("../../public/kicad-viewer/", import.meta.url);
const worker = NodeFS.readFileSync(new URL("parser.worker.js", assets), "utf8");
// Exercise the shipped lexer, with only the Comlink worker bootstrap stubbed.
const listify = NodeVM.runInNewContext(
  worker.replace(/export \{ ce as ParserWorker \};/, "") + "\nB;",
  {
    addEventListener() {},
  },
) as (source: string) => unknown;

it("parses leading decimal coordinates and widths as numbers", () => {
  expect(listify("(pts (xy -2.54 .5) (xy +.25 -.5) (width .254))")).toEqual([
    ["pts", ["xy", -2.54, 0.5], ["xy", 0.25, -0.5], ["width", 0.254]],
  ]);
});

it("preserves quoted numbers, dotted atoms and ordinary numeric tokens", () => {
  expect(listify('(values ".5" .label . 0.5 -2 42)')).toEqual([
    ["values", ".5", ".label", ".", 0.5, -2, 42],
  ]);
});

it("rejects failed project setup and clears loading instead of swallowing the error", async () => {
  const bundle = NodeFS.readFileSync(new URL("ecad-viewer.js", assets), "utf8");
  const start = bundle.indexOf("  async #K(e) {");
  const end = bundle.indexOf("  async #ue(e) {", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const failure = new Error("Invalid schematic coordinate");
  const events: unknown[] = [];
  // Execute the actual bundled setup method with isolated private collaborators.
  const instance = NodeVM.runInNewContext(
    `new (class {
    #i = { load: async () => { throw failure; } };
    #P; #t; #we() {} #m() {} #l() {} #h() {} #g() {}
    run() { return this.#K({}); }
    ${bundle.slice(start, end)}
  })()`,
    {
      failure,
      Error,
      console: { log() {}, error() {} },
      ai: class {
        constructor(public detail: string) {}
      },
      window: {
        dispatchEvent(event: unknown) {
          events.push(event);
        },
      },
    },
  );
  await expect(instance.run()).rejects.toThrow("Invalid schematic coordinate");
  expect(instance.loading).toBe(false);
  expect(events).toHaveLength(1);
});
