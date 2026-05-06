import { Effect } from "effect";

import { loadDesktopIpcPocSnapshot } from "./browser-client.ts";

const program = Effect.gen(function* () {
  const snapshot = yield* loadDesktopIpcPocSnapshot({
    echoText: "hello from the renderer",
    ticks: 5,
  });

  const root = document.querySelector("#root");
  if (root) {
    root.textContent = JSON.stringify(snapshot, null, 2);
  }
}).pipe(Effect.scoped);

Effect.runPromise(program).catch((error: unknown) => {
  const root = document.querySelector("#root");
  if (root) {
    root.textContent = error instanceof Error ? error.message : String(error);
  }
});
