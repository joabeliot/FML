# Live sync: agent ↔ dashboard (FML-23 design)

Status: **design, awaiting sign-off.** The FML-23 ticket asked for a decided
architecture and a scoped v1, not code. The v1 is filed as its own ticket
(see the bottom of this file).

## The ask

An agent (Claude Code, Codex, …) edits a `.fml` / `.rml` on disk, and the
open dashboard shows the change live, with no save and no reload. The
reverse direction (canvas edits reaching the agent without a save) is
implied. JB: "if dashboard isn't the right tool for this am willing to look
for other options too."

## Constraints that shape every option

- **A static site can't watch a file.** The deployed site (protoarch.web.app)
  has no backend by design, and the browser has no push-based file events.
- **File System Access API** (`showDirectoryPicker`) gives a handle you can
  read and write, but it has no change notifications. You'd have to poll
  `getFile()` and compare `lastModified`. It's also Chromium-only, needs
  permission granted again each session, and isn't in Safari or Firefox.
- **Two-way is a merge problem.** If JB is mid-edit when an agent writes,
  something has to decide what wins. Guessing is how edits get silently
  eaten.

## Options

| | How | Works on deployed site | New deps | Feels live | Cost |
|---|---|---|---|---|---|
| **A. Vite dev plugin** | `vite/fileSync.ts`, `apply: "serve"` like `devProxy.ts`. It adds a directory to Vite's own watcher (`server.watcher.add`) and pushes changes over Vite's HMR socket (`server.ws.send("fml:file", …)`); the page listens with `import.meta.hot.on`. | no (dev only) | none | yes (events, not polling) | small |
| B. File System Access polling | "Open folder" in the app; poll handles every ~1s | yes (Chromium only) | none | ~1s lag | medium; permission churn |
| C. Local `fml serve` daemon | a small Node process that watches files and serves a WebSocket; the deployed site connects to `ws://127.0.0.1` | yes, if the browser allows an https page to reach localhost (Chrome's Private Network Access rules are tightening) | a ws lib or raw `node:http` upgrade | yes | largest; a second thing to install and run |

**Recommendation: A for v1.** It's the same shape as `devProxy.ts`: it
exists only while `npm run dev` runs and never ships, which keeps the
no-backend guardrail. It needs no new dependency, because Vite already
bundles chokidar and a websocket, and it's push-based, so it actually feels
live. The cost is that it's local-only, and the person watching an agent
work has the repo checked out anyway. B stays the path if the deployed site
ever needs it. C is only worth it if A turns out to be too limiting.

## v1 scope (one-way: disk → dashboard)

1. `FML_WATCH=<dir> npm run dev`. The plugin watches `*.fml` and `*.rml`
   under that directory. With `FML_WATCH` unset, nothing changes.
2. On connect, the page asks `fml:list` and gets every watched file
   (`{name, text}`). Each change, add or unlink pushes `fml:file` /
   `fml:gone`.
3. Watched files appear in the workspace under their normal keys, marked
   **live** in the sidebar.
4. **Live files are read-only in the dashboard.** The property panel, the
   structural edits, the Source panel and the wire drops all refuse with
   "live from disk — edit the file". This is the honest v1: with one-way
   sync, a dashboard edit would be overwritten by the agent's next write, so
   allowing it would mean losing edits silently. Positions (drag) still work,
   because they never touch the file.
5. When a file changes underneath the canvas: re-parse and keep the
   selection if its id still exists. Optionally flash the nodes whose block
   changed.

Not in v1: writing back to disk, conflict handling, the deployed site.

## v2 sketch (two-way), for when v1 has been lived with

- The dashboard writes back through the same socket: `fml:write {name,
  text, baseHash}`.
- The plugin compares `baseHash` with the file's current hash. If they
  match, it writes. If not, it refuses, and the page shows a "changed on
  disk — reload / keep mine" banner. That's optimistic concurrency, with no
  merge engine.
- Surgical edits (`fmlEdit` / `fmlStructure`) keep the diffs small, so a
  "keep mine" could later re-apply just the one op onto the new text instead
  of the whole file. That's the cheap kind of merge.

## Open questions for sign-off

1. Is dev-only acceptable for v1? (The ticket assumed so; this confirms it.)
2. Is read-only acceptable for live files in v1, or is a "take a local copy"
   button wanted from day one?
3. Should `FML_WATCH` be one directory, or a list? (Leaning one directory,
   recursive.)
