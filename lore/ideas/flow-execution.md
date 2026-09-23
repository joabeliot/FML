# Idea: executable FML flows + variables  (the north star)

**Status:** step 1 (node standardisation), step 2 (variables) and step 3 (the
**engine**) are done — `src/fml/run.ts`, driven by `scripts/run.ts`, executes a
flow against a real API from the terminal today. What's left of step 3 is the
*browser* runner, which is blocked on the CORS answer, and on-canvas result UI.
**Raised by:** JB — "we'll need to add Variables… this is the whole dream for the
tool. i'll execute this api flow in the platform so i can test the api flow."

---

## What it becomes

FML today draws the flow. The dream: **run** it. Pick an `api` flow, hit "Run",
and protoArch fires the requests in order, threads values between them, checks
the responses — a visual API test harness where the diagram *is* the test.

For that, two things FML doesn't have yet:

### 1. Variables — DONE (2026-09-04, `src/fml/variables.ts`)

A value produced by one step, used by a later one. The canonical case:

```
authLogin  →  200  →  capture token from the body
                      later requests send  Authorization: Bearer {token}
```

Shape (decided — JB: "@vars for defaults, secrets stay unset"):
- `{name}` interpolation inside any value string — implemented, resolved (not
  executed) by `resolveVariables()` / `nodeVarUsage()`.
- A new `@vars` section declares literal defaults, same shape as `@meta`.
- `capture.token: $.data.token` on an earlier node also satisfies `{token}` —
  its value isn't known until the request actually runs, but the property
  panel's About tab shows *which node* will produce it.
- A `{name}` that's neither `@vars`-declared nor `capture`d resolves to
  nothing — that's the run-time-input / secret case, by design (a password
  should never sit in a committed file). The future runner prompts for these.
- **Open, not decided:** scope is per-`@doc` today. A `capture` in `main`
  doesn't resolve a `{name}` referenced in a doc it portals into via `flow` —
  even though that's obviously the same journey continuing. Does one *run*
  span multiple docs through their portals, carrying captured values across?
  Needs deciding before the runner (item 3) can thread a variable through a
  `flow` node.

### 2. Execution-ready `api` nodes

The `api` node's key set has to carry enough to actually send the request:

| key | meaning |
|---|---|
| `method` | GET / POST / PUT / PATCH / DELETE |
| `path` / `url` | path against `base`, or a full URL |
| `base` | overrides `@meta base` for this node alone — DONE (2026-09-23), multi-host flows |
| `header.<Name>` | a request header (repeatable) — needs the kv key charset to allow `.` |
| `query.<name>` | a query-string param (repeatable) |
| `body` | request body (JSON) — multi-line body is a `@node` block limitation to solve |
| `auth` | `none` / `bearer {token}` / … |
| `capture.<var>` | pull a value from the response into a variable (JSONPath) |
| `expect` | status assertion for the run — `200`, `200,201` |

`decision` conditions become expressions over variables (`{status} == 200`).
An `event` node can seed the run's starting variables.

---

## Sequencing

1. **Node standardisation** — DONE. Type set + rendering + expected keys
   locked (`src/fml/nodeTypes.ts`); the `api` key set above is the standard.
2. **Variables** — DONE. `{…}` interpolation + `@vars` + `capture` parsing,
   resolved and shown in the property panel. No network yet.
3. **Engine — DONE** (2026-09-05, `src/fml/run.ts` + `scripts/run.ts`). Walks
   the graph, sends each `api` node, threads `capture`d values through one
   run-wide store, asserts `expect`, routes on the response status. Zero deps;
   the transport is an argument, so tests drive it with a fake and Node drives
   it with `fetch` — no CORS in Node, so flows are runnable *now*.
   The cross-doc scope question turned out **not** to block this: at run time
   there is a single flat variable store, so whether a capture crosses a portal
   is a *routing* decision (does the walk step into the portal's doc?), not a
   variables one. Whenever routing says yes, the values are already there.
4. Browser runner: swap the transport for `fetch`-behind-a-proxy (or the
   backend), then per-step pass/fail on the canvas. Blocked on: the CORS
   decision, and the run-result UI.

### Resolved: `expect` vs. a drawn status edge

Raised as an open question, then answered by the examples themselves. `auth.fml`
asserts `expect: 200,202` on `login` *and* draws `-404>` and `-403>` off it;
`app.fml` and `run.fml` do the same. That pairing isn't a contradiction, it's
the idiom: **`expect` asserts the happy path, the edges map every outcome.**

So the engine follows the drawn edge on a failed assertion and keeps walking —
you see where the sad path goes — while the step and the run still score red.
`stopOnFailure` / `--fail-fast` gives the old behaviour. A step with *no
response at all* (unbuildable request, missing variable, dead host) always ends
the walk, because there's no status to route on.

A lint rule that flagged the pairing was written, fired on three of five
shipped examples, and was deleted. Worth remembering: when a check fires on
your own canonical examples, the check is usually what's wrong.

### CORS — decided (2026-09-05)

JB picked **dev-proxy-only** for now. `vite/devProxy.ts` forwards requests in
`vite dev` (`apply: "serve"`, so it never ships); the built site calls `fetch`
directly and therefore reaches CORS-permissive APIs only.

The permanent options, for when this comes back: (1) the target API allows our
origin — the correct fix when you own the API, which is the common case for
this tool; (2) a hosted proxy — works with anything, but it becomes a service
that sees every token a run sends, which is a trust obligation, not a deploy
step; (3) leave the browser (desktop app / the CLI, which already works); (4) a
browser extension. Nothing client-side can grant the permission — it belongs to
the target server, by design.

Related: [[fml-on-fml]] (a `flow` portal could be a reusable sub-sequence in a
run), [[edge-notes]] (an edge could carry a `when:` guard for the runner).
