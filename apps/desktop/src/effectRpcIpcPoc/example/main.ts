import * as Path from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";
import { app, BrowserWindow, ipcMain } from "electron";

import { makeElectronIpcMainPort } from "../library/main.ts";
import { runDesktopIpcPocRpcServer } from "./rpc-server.ts";

const isMac = process.platform === "darwin";

export const makeMainWindow = Effect.sync(() => {
  const window = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: Path.join(__dirname, "preload.cjs"),
    },
  });

  void window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Effect RPC Electron IPC POC</title>
        </head>
        <body>
          <main id="root">Renderer bundle would call example/renderer.ts here.</main>
        </body>
      </html>
    `)}`,
  );

  return window;
});

export const installElectronLifecycleHandlers = Effect.acquireRelease(
  Effect.sync(() => {
    const onWindowAllClosed = () => {
      if (!isMac) {
        app.quit();
      }
    };

    const onActivate = () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        Effect.runFork(makeMainWindow);
      }
    };

    app.on("window-all-closed", onWindowAllClosed);
    app.on("activate", onActivate);

    return {
      onActivate,
      onWindowAllClosed,
    };
  }),
  ({ onActivate, onWindowAllClosed }) =>
    Effect.sync(() => {
      app.off("activate", onActivate);
      app.off("window-all-closed", onWindowAllClosed);
    }),
);

export const waitForElectronAppReady = Effect.promise(() => app.whenReady());

export const waitForElectronAppQuit = Effect.callback<void>((resume) => {
  const onBeforeQuit = () => {
    resume(Effect.void);
  };

  app.once("before-quit", onBeforeQuit);

  return Effect.sync(() => {
    app.off("before-quit", onBeforeQuit);
  });
});

export const main = Effect.gen(function* () {
  yield* waitForElectronAppReady;
  yield* installElectronLifecycleHandlers;
  yield* runDesktopIpcPocRpcServer({
    port: makeElectronIpcMainPort(ipcMain),
    appVersion: app.getVersion(),
    platform: process.platform,
  });
  yield* makeMainWindow;
  yield* waitForElectronAppQuit;
}).pipe(Effect.scoped);

NodeRuntime.runMain(main);
