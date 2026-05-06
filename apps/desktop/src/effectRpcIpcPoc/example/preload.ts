import { contextBridge, ipcRenderer } from "electron";

import { exposeEffectRpcIpcPreloadBridge } from "../library/preload.ts";

exposeEffectRpcIpcPreloadBridge({
  contextBridge,
  ipcRenderer,
});
