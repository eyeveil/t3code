# Deploy internals & post-mortems

## Why a complete runtime swap, not a global reinstall

`apps/server` uses pnpm `catalog:` deps that `npm` cannot resolve, and node-pty
cannot gyp-rebuild on hosts without python. So `npm i -g <tarball>` fails. The
server bundle also externalizes its dependencies, which means swapping only
`dist/` is unsafe whenever the workspace catalog changes. Stage a complete
runtime with resolved dependencies and the already-built host node-pty module,
then swap the package directory atomically. `<global package>.old` is the
rollback copy and `<global package>.failed` preserves a rejected runtime.

The 2026-08-04 rollback exposed both failure modes. The fresh build had been
copied into an existing staging directory, leaving the new bundle under
`dist/dist` and stale code at the actual entry point. A correctly laid-out new
bundle also failed an isolated import against the old global dependencies:
Effect beta.102 does not export `McpProtocol`, while the beta.103-built server
imports it. Complete-runtime staging rejects both nested output and dependency
skew before the live server is stopped.

## The idle signal

`busy_sessions()` counts rows in `projection_thread_sessions` with status
`running` or `starting`. The gate requires **3 consecutive zero polls, 20s
apart** — a single poll can catch a turn mid-settle and false-idle. Deadline is
12h, after which it gives up and notifies rather than deploying blind.

Do NOT use log/WAL mtimes as an idle signal: a periodic health check (e.g. a
Grok ping every 5 min) writes trace spans, so those files are never "quiet."

## Debugging thread issues on the host

- Per-thread provider logs: `~/.t3/userdata/logs/provider/<threadId>.log`
  (CANON/NTIVE ndjson).
- Projection tables in `~/.t3/userdata/state.sqlite` (`projection_*`).
- Claude transcripts: `~/.claude/projects/<cwd-munged>/<sessionId>.jsonl`.
  Resume only searches the dir munged from the spawn cwd.

## Post-mortem: the 2026-07-05 double outage (why the restart logic is what it is)

A deploy's restart did `send-keys` into the serve pane plus a single 5s `pgrep`
to confirm health. But the serve pane runs `t3 serve` as its **foreground
command with no shell** — killing serve made the pane and its window exit, so
`send-keys` landed nowhere and the process never restarted. The lone early
`pgrep` then false-negatived a perfectly healthy build as "serve did not come
back," which triggered a rollback — whose restart hit the same bug. Result: t3
fully down through both deploy AND rollback; clients saw
`failed to fetch remote environment endpoint / transport error`.

The script now: captures the owning window id, stops serve, **kills the window
and spawns a fresh named serve window**, then polls the real health endpoint for
~20s before declaring failure. Manual recovery is a one-liner:

```bash
tmux new-window -d -t main -n t3- 't3 serve --host 0.0.0.0'
```

## Build note

`npx vp run --filter t3 build` builds `@t3tools/web` first, then packs
`apps/server/dist` with the web client bundled at `dist/client`. `vp` lives in
`node_modules/.bin`, not on PATH — invoke via `npx vp` (or add it to PATH).
