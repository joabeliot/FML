# Context — F*ML

**Focus:** FML — `.fml` Flowchart Markup Language: parser (`src/fml/`) + web viewer (React Flow + dagre)
**Phase:** R&D → the north star is real. **Flows execute**: `src/fml/run.ts` sends `api` nodes, threads `capture`d values between calls, asserts `expect`, routes on status — runnable today via `node scripts/run.ts <file.fml>`. Run UI (canvas-as-test-report, camera-follow) reviewed by JB and shipped. `examples/branching.fml` demonstrates status-based forks. Multi-host per-node `base` override built (`feature/multi-host-base`, not yet reviewed/merged). Portal bubbles shipped. Live at https://protoarch.web.app / https://fml.arque.app
**Open:** multi-host `base` override on `feature/multi-host-base` awaiting JB review before merge; api-node *authoring* UI (first-class fields for method/path/header/capture instead of generic kv rows) not started; run targets the active doc only — a bubble's contents aren't runnable, and a `flow` portal isn't stepped into (the routing half of the cross-doc question); cross-doc variable scope still undecided as a *routing* question — does a run step into a `flow` portal's doc? (the variable half dissolved: one run has one flat store); deployed site can only reach CORS-permissive APIs by design (dev proxy is dev-only); bubble contents are read/edit-only, not draggable; node rename + add/delete node/edge (structural — needs an FmlDoc→text serializer); breadcrumb for portal drill-down (the jump itself works); "Open folder" (File System Access API); sidebar resize; label crowding on primary+reciprocal at one node; `#` in a value is still eaten by the comment lexer (JB's call); `public/index.html` is dead Firebase boilerplate; a handful of `lore/` reference docs (`GUARDRAILS.md`, `INDEX.md`, `architecture/*.md`, `ideas/*.md`, `testing/registry.md`) still say "protoArch" here and there — not yet swept, low-stakes
**Next:** JB to review the multi-host `base` feature; then first-class `api` authoring fields in the property panel

---

## Log

### 2026-09-23 — JB / Claude — Multi-host support
JB pasted a feature spec from a Stablish fixture he hit running FML for real:
one file, two services (`auth.stablishdev.com` + `api.stablishdev.com`), and
`@meta base` only ever covers one origin.

Added `base:` as a key **on the node itself** — `buildRequest` now prefers
`node.data.base` over `meta.base`, falling back exactly as before when a node
doesn't set one. `{name}` interpolates in a node `base` too, same as `path`.
No parser changes needed — `@node` bodies already parse any `key: value`
generically, so this was a `run.ts`/`lint.ts`/`nodeTypes.ts` change, not a
grammar one.

`lint.ts`'s "relative path with no base" check now looks at both — a node
with its own `base` and no `@meta base` at all is not flagged. `nodeTypes.ts`
gained `base` in the `api` optional set so it's not flagged as an unknown key.

Built `examples/multi-host.fml`: captures `username` from
jsonplaceholder.typicode.com, spends it on httpbin.org via an `echoUser` node
with its own `base:` — a value threaded across hosts, not just two literal
URLs. Ran it live (not just parsed): PASS, `{username}` round-tripped through
httpbin's echo. `--dry` prints the resolved `method url` per node either way,
so which base a node actually used is visible on a failure too — that was the
spec's actual ask, and it fell out of the existing plan-printer for free.

5 tests added (`run.test.ts`: node base wins over `@meta base`, falls back when
absent, interpolates; `lint.test.ts`: node base satisfies the no-base check),
one existing assertion updated for the reworded message. `npm test` and
`npm run build` clean. `HOW-TO.md` gained a
"Multiple hosts in one file" section under `api` keys, since JB is handing
that doc to another Claude session to author flows. On `feature/multi-host-base`,
not merged — JB to review.


### 2026-09-05 — JB / Claude (cont.) — The run UI
JB: *"run the ui… plan the ui properly with the ux in mind… is there a way to
make it look like the req flow is going through the nodes and edges."*

Design principle everything hangs off: **the canvas is the test report.** Postman
gives you a list; F*ML already has the map, so results belong *on* the map. Put
the run output in a log pane and we'd have built a worse Postman.

- **Run/Stop** in the toolbar, first and visually weighted — it's what the tool
  is for.
- **The step badge becomes the status.** A node's position in the flow and its
  result are the same fact, so it stays one control rather than crowding an
  already-busy card: pulse in flight, green ✓, red ✕. Card gets a matching ring;
  a node the run never reached dims out.
- **Run bar** (JB picked full-width bottom over reusing the Walkthrough panel):
  verdict, every step in order with status/timing, and the **live variable
  store** so captures visibly fill in as they land.
- **Run tab in the property panel** — exact request sent, response
  pretty-printed, what was captured. The API-client inspector, reached by
  clicking the box on the map.
- **Pre-flight inputs** for `{name}`s the file can't supply. React state only:
  never the .fml, never localStorage. A tool that quietly persists your
  credentials would undo the entire reason secrets stay out of the file.

**The animation.** Requests return far too fast to perceive, so the run is
paced — but *not* by putting `setTimeout` in the engine. `runFlow`'s callbacks
became awaitable (`onStepStart` / `onStep` / `onEdge`), so the caller holds the
walk open as long as it likes. The engine stays pure and full-speed; the UI is
what decides a beat is 220/260/380ms. `fast` turns the floors off. Nothing here
touches a reported duration — those come from the transport. The pulse itself is
an SVG `animateMotion` riding the edge's own path via `mpath`, so it follows
every corner of the orthogonal route for free.

**Bug caught while verifying:** feeding run state through `chartNodes`/
`chartEdges` gave them a new identity every tick, which re-triggered `fitView` —
the viewport would have yanked around on every single beat of a run. Split the
effects: a cheap mirror on every change, and reset+refit on a new `fitKey` that
only moves when the graph actually changes. Found by instrumenting the DOM, not
by looking at it.

Verified in-browser end to end: happy path (PASS, 2 requests, captures threading
into request 2), failure path (red ✕, walks the modelled `-404>` edge to
NotFound, unreached nodes dim, exit-equivalent FAIL), the inputs prompt, the Run
tab, and the travelling pulse (confirmed via MutationObserver: circle +
animateMotion + lit path all rendered). 242 tests green, build clean.

### 2026-09-05 — JB / Claude (cont.) — The flows execute
JB: *"work on the api logic… calling the api and storing that into a variable
and using that variable inside another api's request."* That's the north star
from `ideas/flow-execution.md`, and the spec for it was already written there —
so this was implementation, not design.

**`src/fml/run.ts`** — walks a doc, sends each `api` node, folds every
`capture.<name>` into one run-wide store so the next request spends it, asserts
`expect`, routes on the response status. Zero deps, per the `src/fml/` rule.

The decision that made it finishable: **the engine takes its transport as an
argument and never calls the network itself.** Tests drive it with a fake,
`scripts/run.ts` drives it with Node's `fetch`. That's why it was completed and
tested *before* the CORS question was answered — and why flows run from the
terminal today with no backend at all. Verified live against a public sandbox
API: captured a value from request 1, spent it in request 2, routed on 404,
exit 1 on failure.

Strictness calls, all in the same direction (a test harness that lies is worse
than none): a `capture` that finds nothing **fails the step**; a request with an
unresolved `{name}` is **never sent**; an unevaluable branch **stops and says
where** instead of guessing a path and reporting green.

**`src/fml/lint.ts`** — the "api node standardisation" half. Semantic checks
keyed by node id (not line, so the canvas can point at them): keys outside the
type's standard (the `heder.Accept` typo catcher), `path` with no `@meta base`,
bad method, malformed `expect`, empty capture path, run-time inputs as info.
Surfaced in `scripts/demo.ts` under **checks**.

It immediately earned itself twice. It found five api nodes across
`shop.fml` / `multi.fml` / `fof/*` with relative paths and **no base** —
genuinely unrunnable; fixed by adding `@meta base`. And it caught *itself*: a
rule flagging `expect: 200` alongside a drawn `-404>` fired on three of five
shipped examples, including canonical `auth.fml`. That pairing is the idiom, not
a contradiction — so the rule was deleted **and the engine's default changed** to
follow the drawn edge on a failed assertion (still red, `--fail-fast` for the
old behaviour). Lesson worth keeping: when a check fires on your own canonical
examples, the check is what's wrong.

**CORS** — JB asked for the permanent answer, got the first-principles one: the
permission belongs to the target server, so nothing client-side can grant it.
He chose dev-proxy-only. `vite/devProxy.ts` (`apply: "serve"`, never ships) +
`src/lib/httpTransport.ts` (proxy in dev, direct `fetch` built, with a real
error message instead of the browser's opaque "Failed to fetch"). Proxy verified
by hand. Deployed site therefore reaches CORS-permissive APIs only — by design,
guardrail intact.

77 new tests (242 total), typecheck + build clean, every example parses strict
*and* lints clean. On `feature/flow-runner`, unmerged — no UI yet, which is the
next piece.

### 2026-09-05 — JB / Claude (cont.) — Portal bubble expansion (feature/portal-bubbles)
JB confirmed the drag-repel feel ("perfect") then asked for the fof/doc bubble
feature: an expand toggle on `flow` portal nodes that unfolds the target doc
inline, right under the card, wrapped in a tinted frame — same idea as
expanding a group in Neo4j Bloom. He asked for this to land on a feature
branch he'd review himself, not `main`, so: committed the pending session log
to `main` (07c779c), cut `feature/portal-bubbles` from there, built the whole
thing on it.

Architecture: extracted the shared dagre → back-edge-routing → fan-out
pipeline out of `useFmlChart.ts` into `src/lib/docGraph.ts`
(`buildDocGraph`/`refineEdges`), reused by both the active doc and a new
`src/lib/expandPortal.ts::expandPortal()` — lays out a target doc completely on
its own, then re-homes it as a self-contained "bubble": one synthetic
`bubble`-type container node (`src/components/nodes/BubbleNode.tsx`, tinted
with `--color-flow`) holding the sub-doc's nodes as React Flow children
(`parentId` + `extent:"parent"`), every id namespaced `${portalId}::${rawId}`
to guarantee no collision with the active doc. `App.tsx` owns `expanded: Set
<string>` state, a `bubbles` memo (one `expandPortal` call per expanded
portal), merges bubble nodes/edges into what `FlowCanvas` actually renders,
and resolves a bubble-child selection back to its real doc + raw id
(`bubbleIdMap`) so property-panel edits write into the *correct* underlying
file/doc — verified end to end in a real browser (edited a bubble child's
`method` field, confirmed the write landed in the right `@doc` block and nowhere
else).

Scope calls made without a fresh check-in (flagged here for JB to challenge on
review): bubble contents are **not draggable** — v1 treats it as a read/edit
peek, not a rearrangeable mini-canvas, to sidestep parent-relative-drag +
physics-with-nesting edge cases; bubble state doesn't persist — collapse
forgets, next expand recomputes fresh from dagre; multiple bubbles can be open
at once side by side, each independent; collapsing a bubble while something
inside it is selected now clears the selection (was showing a confusing
"element is no longer in the doc" message — fixed same session, caught via
browser verification, not by JB).

Verified: typecheck/tests/build all green, unaffected by the refactor (38
tests, 0 failed). Browser-verified via a local dev server + `examples/multi.fml`
(two sibling `@doc`s in one file) — single bubble expand/collapse, two bubbles
open simultaneously (no overlap, confirmed via bounding-box checks across all
12 rendered nodes), selection resolution, and a live property-panel edit
round-tripping into the right doc's source text. Did **not** test real-mouse
drag interaction (same tool limitation as the physics feature — this
environment can't produce real pointerdown/up drag gestures).
Not pushed anywhere — sits on `feature/portal-bubbles` for JB's review per his
"cut a branch, I'll look and tell you what I want changed" instruction.

### 2026-09-05 — JB / Claude (cont.) — Physics redesigned to be drag-only
JB tried the first version and gave sharp, specific feedback: **"the flowchart
felt like jelly, thats not what i want, the reaction to be active only when i
click and drag the nodes around, in other cases i want it to just like it is
now."** Root cause: the first version reheated the simulation (`alpha(0.6)
.restart()`) on *every* structural change — any edit, not just a drag — so the
whole graph visibly re-settled on every keystroke-driven commit. Not a tuning
problem, a design problem.

Rewrote `useForceLayout.ts` from scratch: the hook now holds **no** ambient
state. `positions` starts empty and *only* gets populated between
`onDragStart` and `onDragEnd` — at rest the graph is exactly dagre's own
static output, no exceptions. Also dropped the anchor/rank-pull force
entirely (`forceX`/`forceY` toward the dagre position) — it was fighting
pushed neighbours, trying to spring them back to their old spot, which was
part of the "jelly" feel. A drag now seeds the simulation from wherever every
node currently sits (its frozen spot from an earlier push this session, or
dagre's raw position), runs pure collision + light repulsion — nothing else —
while the pointer is held, and `onDragEnd` calls `sim.stop()` immediately:
whatever the spacing is at that instant is frozen, no continued settle, no
snap-back. Any real structural change (new parse, doc switch — the same
`useEffect` that already reseeds `nodes`/`edges` from `chartNodes`) calls a
new `force.reset()` that drops straight back to the static baseline.

Persistence is unchanged and JB confirmed this is what he wants: only the
node(s) you actually dragged get saved (`nodePositions.ts`, outside the
`.fml` — positions still never go into the source). A neighbour nudged out of
the way during someone else's drag is *not* separately remembered — it
reverts to dagre's own spot the next time the doc reparses. That was already
the existing behaviour; nothing changed there.

Verified via direct DOM inspection: read every node's rendered `transform` on
load, waited 2s, read again — **byte-identical, zero drift**. Confirms the
"no idle motion, ever" requirement architecturally, not just by eyeballing a
screenshot. The live push-while-dragging feel is still unverified with a real
mouse, same tool limitation as before — flagged, not deployed yet.

### 2026-09-05 — JB / Claude — Repulsion physics on top of dagre
JB: "i want the nodes to behave like they repel eachother with a threashold...
exactly like neo4j nodes and edges." Flagged the tension first — Neo4j's graph
view is pure force-directed (no rank, no top-to-bottom order), which would
undo the orthogonal routing / back-edge gutters / step badges / PREV-NEXT trace
colour all built around dagre's ranked layout. Asked which he meant; JB:
**"option A, the flow should still be top to bottom"** — repulsion layered on
the existing layout, not a replacement.

Shipped (not deployed — JB needs to verify the live-drag feel first, see Open):
- New dependency `d3-force`. `layout.ts` gains `nodeSize()` (the same
  width/height estimate dagre already used internally, now shared).
- New `src/hooks/useForceLayout.ts`: a `forceSimulation` seeded from dagre's
  positions. `forceCollide` (radius = half-diagonal + padding) is the actual
  "repel with a threshold" — two cards can never overlap. `forceManyBody`
  adds general breathing room. `forceY`/`forceX` (whichever is the rank axis
  for the current `dir`) pulls each node back toward its dagre position,
  strongly on the rank axis (keeps top-to-bottom order) and weakly on the free
  axis (so collision still has room to spread nodes sideways). Existing nodes
  keep their current settled/dragged spot across an unrelated edit — only
  size/anchor refresh — so editing a node's text doesn't reset the whole
  graph; new nodes seed in at their dagre spot and animate to a settle.
- Dagre still owns *structure* — rank, back-edge routing, handle sides, badge
  order — computed once in `useFmlChart` before physics ever runs; the force
  layer only refines final pixel position in `FlowCanvas`, so nothing else in
  the pipeline needed to change.
- `FlowCanvas`: `onNodeDrag` pins the dragged node in the simulation
  (`fx/fy`) and reheats it so neighbours push away live; `onNodeDragStop`
  re-anchors it to the drop point (so the rank-pull doesn't fight the user's
  own placement) before releasing the pin. The currently-dragged node's own
  position always comes from React Flow's own state, never a physics tick,
  to avoid a one-frame-stale fight.

Verified via direct DOM inspection (not just screenshots): built an 8-node,
3-way-branch test doc, confirmed **zero bounding-box overlaps** after settle,
confirmed the existing self-loop routing and top-to-bottom order both still
render correctly. Could **not** verify the live drag-reactive part — spent a
long debugging pass (raw `pointerdown/move/up` listener at the window level)
and confirmed the browser-automation tool in this environment fires
`pointermove` but never `pointerdown`/`pointerup` against this page, so
React Flow never starts a drag session no matter what the code does. Ruled
out the code as the cause (tested with the physics override fully disabled —
still no movement) before concluding it's a tool limitation. Flagged to JB to
test with a real mouse rather than claiming something unverified works.

Also this session: JB shared the **expand a `flow`/`@fof` portal into a
coloured "bubble" of its sub-doc's nodes, right there on the canvas** idea —
an expand toggle next to the step badge, React Flow's parent/child grouped
nodes are a natural fit. Designed, not built — deliberately sequenced after
the repulsion foundation (an expanded bubble's nodes need room, which physics
now provides) rather than building both large things in one pass.

Also: JB pointed at **https://fml.arque.app** as "the official site" — a
custom domain he set up in Firebase pointing at the same `protoarch` hosting
project (confirmed via fetch: same deployed app). No repo config to update —
custom domains aren't stored there.

### 2026-09-04 — JB / Claude (cont.) — Variables land: `@vars` + `capture` resolution
JB: "we're gonna work on standardising some nodes coz we need to perform
actions with those nodes... this brings me to another feature variables...
we're evolving this tool." Checked first — node standardisation for `api`
(`method`/`path` required, `header.*`/`query.*`/`capture.*`/`body`/`auth`/
`expect` optional) already landed earlier today; this round is
`lore/ideas/flow-execution.md`'s own step 2: variables.

One blocking grammar decision, asked directly: where does a variable like
`{email}` (not captured from a response — a flow input) get its value?
JB: **"Both — @vars for defaults, secrets stay unset."**

Shipped:
- `FmlDoc.vars: Record<string,string>` — new `@vars` section, parses exactly
  like `@meta` (`src/fml/parse.ts`, `types.ts`). Per-doc, like `@meta`.
- New `src/fml/variables.ts`: `varsInValue`/`varsInNode` find every `{name}`
  in a value/node; `resolveVariables(doc)` builds a name → source map from
  `@vars` (wins on collision) + every node's `capture.<name>`;
  `nodeVarUsage(node, resolved)` is the per-node view. 14 new tests
  (`variables.test.ts`) + 5 parser tests for `@vars` itself. 162 total.
- Property panel's **About** tab gets a **Variables** section: `{email} →
  "demo@example.com"`, `{token} → captured by authLogin`, or `{password} →
  not set, asked for when run` (warn-coloured). Verified all three states in
  the browser.
- Sample (`sample.ts`) got a real `@vars: email: ...` — `password` stays
  undeclared on purpose, demonstrating the "secrets stay unset" call.
- `HOW-TO.md`: new `@vars` section, file-shape table row, a full "Variables —
  {name}" subsection under the exec-ready `api` keys, viewer-section bullet,
  checklist row, error-table row. `README.md`'s language table too.
  `lore/ideas/flow-execution.md` marked steps 1+2 done, step 3 (runner)
  blocked on two things now named explicitly.
No network call anywhere — deliberately. That's step 3 (runner), needs a
CORS/backend story that hasn't been decided.
**Real gap surfaced, not solved:** resolution is per-`@doc`. A `capture` in
`main` doesn't satisfy a `{name}` used in a doc it portals into via `flow` —
even though that's obviously one continuous journey. Checked live: checkout's
`payApi` still shows `{token} → not set` despite `main`'s `authLogin`
capturing it, because they're different docs. Whether one *run* should span
docs through their portals (carrying captured values across) is a real,
undecided design question — flagged in both `flow-execution.md` and here, not
silently papered over.
Not done (didn't expand scope without asking): the property-panel "fixed vs.
freeform field" UI split floated as a possible reading of "standardising
nodes" — mentioned to JB, not built; would be a separate small round.

### 2026-09-04 — JB / Claude (cont.) — HOW-TO multi-file docs + reviewed/deployed a second agent's feature
Two small asks. (1) HOW-TO.md was missing the multi-file / multi-flow syntax —
added real sections for `@meta` (`title`, `base` → `api` path root), `@doc`
(multiple flows per file, doc-local ids, no cross-doc arrows), portals (a `flow`
node's `doc:` key), and `@fof` (`<path> as <name>`, no extension, nesting,
circular-import handling). File-shape table, error table, hand-off checklist
extended. Fixed a stale comment in `examples/multi.fml` that contradicted its own
portal usage. `70e36bc`.
(2) A different Claude session (Sonnet 4.6) pushed `a992180` straight to `main` —
"About tab + Walkthrough". PropertyPanel gets a Props/About tab switcher; About
surfaces the node's `note` as prose + lists inbound/outbound edges with labels.
Sidebar gets a Walkthrough section: BFS-traces the active doc, renders a
plain-text step list, marks loops with ↩. Reviewed the diff — additive, isolated
to 2 components + one prop wire-through, style matches. typecheck + 134 tests +
build green; both features verified in the browser. Deployed to
https://protoarch.web.app.
Nits noted, not blocking: `buildWalkthrough` re-filters edges in its loop
(O(V·E), fine at this scale); `isBack` flags any already-visited target so
convergent paths can get a spurious "loop" mark depending on BFS order;
disconnected cycle-islands past the first component aren't walked.
Naming (parked): FML = the language/format, protoArch = the product/company.
Repo renamed to `arque-app/ProtoArch`; git remote updated.
(3) Layout-cleanup pass 1 (`96b9018`, deployed). JB + his brother: "the graph
looks like a mess." Diagnosis: not node overlap — it's bezier edges cutting
diagonally + straight chains staircasing. Pure force relaxation is the wrong
tool for a ranked flowchart. Fix: forward edges → `getSmoothStepPath`
(orthogonal, 8px corners) in `FlowEdge`; back/reciprocal/parallel keep the
bowed C-curve. dagre `align: "UL"` + `nodesep`/`ranksep` 54/100 to straighten
chains.
(4) Pass 2 (`cf546d1`, deployed). JB on a real Plaid-resync graph: still messy.
Two changes: (a) **step-number badges** — `layout.ts` numbers nodes 1..k by
dagre rank (same-rank nodes share a number), rendered as a small accent pill
top-right of every card (`FmlNode`, `FmlNodeData.order`). (b) **all edges
orthogonal** — dropped the bowed-bezier branch in `FlowEdge` entirely;
reciprocal/repeated/back edges now use `getSmoothStepPath` too, stood off into
a gutter via `offset` (24 + tier*18; routed=30), so long returns run in a tidy
vertical lane instead of a curve across the diagram.
`service` isn't in the 5-type standard so that agent's file threw 7 warnings.
(5) Pass 3 + trace feature (`0c1ba27` + `8de77c2`, deployed). On a real
Plaid-resync graph JB reported labels still hidden. Root cause: React Flow
paints the node layer *after* the edge-label layer with no z-index, so any
label over a card is covered — fixed by `z-[6]` + shadow on the label. Also
`fanEdges` in `useFmlChart` tags each edge with its index among siblings that
share an exit/entry point; `FlowEdge` spreads the endpoint along the node side
(clamped to the border) so stacked labels ("step 1"/"step 2") separate.
Then, JB's ask: the step badge is now a button — click it and the canvas
spotlights that node's one-hop neighbourhood (self badge fills, predecessors
tagged PREV, successors NEXT, everything else → 20%). `trace` state in App,
neighbour sets computed in FlowCanvas; clears on Esc / pane-click / doc switch.
(6) DockPanel + toolbar trim (`b27dd15` → `687ebfc`, deployed). JB wanted
Walkthrough and Warnings out of their spots, collapsible, and the toolbar
stripped down. New `DockPanel` — a bottom-corner floating card whose title bar
is always shown and collapses the body to just that bar (state persisted per
panel; `raise` prop lifts it above the zoom controls; collapsed state
shrink-wraps its title). Walkthrough left the sidebar for `WalkthroughPanel`
(now bottom-right, above the zoom controls); `buildWalkthrough` moved there;
Sidebar no longer takes `edges`. Warnings/errors: `IssueList` deleted — the
toolbar's count is now a button opening a dropdown (outside-click / Esc close
via a capture-phase listener, since React Flow's pane eats bubble-phase
events). Zoom `<Controls>` → `bottom-right`. Toolbar stripped: removed the
node/edge stat readout, `TB`/`LR`, `strict`, `Fit`; layout is now permanently
"TB" and parsing permanently loose (`useFmlChart(ws, activeDoc, "TB", false)`).
Toolbar is Open / Save / Source / Reset + the issues dropdown. HOW-TO viewer
section updated to match.
(7) Placement churn, settled (`33e37a7` → `ae08b93`, deployed). JB: Reset gone
from the toolbar too (Open / Save / Source only). Edge labels capped at
`max-w-[150px] truncate` + full text on hover — a long label no longer spans
the diagram and hides the node under it. Walkthrough: briefly moved into the
sidebar, then back out to a `DockPanel` minimizable card **bottom-left**
(opposite the bottom-right zoom controls). `Controls` at `bottom-right`.
(8) Label-vs-node avoidance + Code tab (`26511cf`, deployed). `layout.ts`
exports `nodeRects` (boxes from the same size estimate dagre uses). New
`placeLabels` in `useFmlChart` gives every non-routed edge a `data.lx/ly`
anchor that isn't inside any node box — slides the midpoint toward the source
end, then sideways, until clear; `FlowEdge` uses it. Routed back edges keep the
gutter anchor and no longer get the fan-shift (that was curling the path — the
artifact JB kept seeing near `historyCompleteCheck`). Property panel gets a
third tab, **Code**: the selected node's literal FML (decl line + `@node { }`
block) in a textarea with copy / apply / revert. `fmlEdit.ts` gains
`nodeSource` (extract) and `setNodeSource` (parse edited text → type swap +
block rewrite via the existing targeted edits — comments inside the block are
not preserved). 4 new fmlEdit tests, 143 total.
`placeLabels` was reverted immediately (`e052ed9`) — it anchored on the
straight centre-to-centre line while paths are orthogonal, so labels detached
into empty space and stacked. Back to `getSmoothStepPath`'s own label point;
kept the `max-w-[150px]` cap + the no-fan-shift-on-routed fix. Label-on-node is
back to "small capped chip on the path" — acceptable, not a banner. A bounded
(~24px) perpendicular nudge is the careful version if it comes up again.
(9) Self-loop routing (`a8b7868`, deployed). The `↻`/`U` artifacts JB kept
seeing (near `historyCompleteCheck`, `ResyncPlaid` in his Plaid graph) were
self-referencing edges (`X -label> X`) — they got the default bottom→top
handles of their *own* card, a zero-distance path that folded flat and put the
label dead-center on the title (screenshot showed the label text literally
interleaved with the node name). `toReactFlow` now detects `source === target`
and routes it right→top instead (cycling through 4 side-pairs if a node has
more than one self edge); `FlowEdge` gives self-loops a bigger offset (40),
skips the fan shift. Verified with a constructed self-loop doc: the loop bows
out beside the card and back in above it, label included, clear of the title.
Also this round: `placeLabels` (item 8) was reverted one turn after shipping —
it anchored on the straight centre-to-centre line while paths are orthogonal,
so on a dense graph it flung labels away from their edges. Back to
`getSmoothStepPath`'s own label point; kept the width cap.
(10) Drag persistence (`362d73b`, deployed). JB: dragging a node then switching
docs and back lost the move — `chartNodes` is recomputed fresh by dagre on
every `useFmlChart` recompute (which fires on a doc switch), and the drag
lived only in FlowCanvas's local React Flow state. Fix keeps positions **out
of the `.fml`** (still layout-free by design) but persists them separately:
new `src/lib/nodePositions.ts`, one localStorage blob keyed by doc (file + doc
name — the same doc name can live in different `@fof` files) → node id →
`{x,y}`. `useFmlChart` merges saved positions over the dagre result after
`layout()` (and now also uses the *positioned* nodes, not the raw dagre ones,
when deciding which edges are back-edges — more accurate once a node's been
dragged). `FlowCanvas` saves on `onNodeDragStop` (drag end, immediately, no
debounce; covers a multi-node drag). Verified: dragged Login, switched to
checkout and back to main, it stayed put. HOW-TO viewer section updated
(also caught it still mentioning the removed Reset button — fixed).
Still open: long rank-skipping edges get a lonely lane; big graphs sprawl;
dagre doesn't route other nodes around a hand-placed one on next layout.
(11) Two logo concepts shared (not yet in the app): **F\*ML** — bold all-caps
mark, asterisk standing in for the joke rather than spelling it — meant for
the dev-facing language identity; **protoArch** — rounder, friendlier bold
wordmark for the product. Deliberately different typographic voices (loud dev
mark vs. polished product mark), matching the FML/protoArch split already
agreed. Waiting on JB for either a font/vector source or final PNGs before
wiring either into the sidebar — Tailwind here can only pull webfonts from
Google Fonts, so a custom/paid face means PNG, not a font swap.
(12) Repo moved (git remote updated, not deployed — no code change): JB
transferred the GitHub repo from `arque-app/ProtoArch` to
`github.com/joabeliot/ProtoArch` (personal account). History intact — fetch
confirmed `origin/main` matches local HEAD after the remote switch. Updated
`CLAUDE.md`'s Repo line; this file's header above.
(13) Trackpad pan (`8b7f32e`, deployed). JB: two-finger scroll zoomed instead
of panning. `<ReactFlow>` was on defaults (`zoomOnScroll: true`); set
`panOnScroll` + `zoomOnScroll={false}` + `zoomOnPinch` (kept explicit) —
two-finger scroll pans, pinch zooms, matching Figma/Miro. Config-only; couldn't
simulate a real trackpad gesture to verify feel, flagged that to JB.
(14) Trace direction colour (`a3a3cc9`, deployed). JB: colour in/out edges
differently during a badge-trace. `TRACE_IN` (blue `#5b9dd9`) / `TRACE_OUT`
(orange `#e8935a`) added to `nodeStyle.ts`, deliberately outside the node-type
palette so the meaning is stable regardless of node type. Edge stroke +
arrowhead colour by `traceView.edgeRole`; the PREV/NEXT tag on the node at the
other end matches. Verified on a plain edge and a gutter-routed back edge —
both colour correctly.
(15) **The FML/protoArch split is reversed — the product is now F\*ML, full
stop.** JB: "am going to change it to be FML no protoarch... fml just sounds
good." The two-name split from earlier this session ([[protoarch-vs-fml-naming]]
memory) is stale — record superseded. Repo moved again:
`github.com/joabeliot/ProtoArch` → `github.com/joabeliot/FML` (git remote
updated, verified). JB scoped the rename to **docs + in-app text only**, keeping
the live deploy at protoarch.web.app / Firebase project `protoarch` for now
(explicit choice — a domain/Firebase-project move is a separate, bigger
decision). Renamed: `CLAUDE.md` title + Repo line, `README.md` title + the two
"protoArch fires/draws" mentions, `index.html` `<title>`, `package.json` name
(`protoarque` → `fml`, `package-lock.json` synced), the sidebar wordmark
(`Sidebar.tsx`) — dropped the now-redundant small "fml" mono tag next to it
since the wordmark itself says the name. Left as-is (internal, not
user-visible): the `protoarque_fml_*` localStorage key names in `App.tsx` /
`nodePositions.ts` — renaming would silently drop existing users' saved
workspace/positions for no visible benefit. Left as-is (JB's explicit scope —
deploy target unchanged): the `protoarch.web.app` / Firebase project
`protoarch` mentions in `CLAUDE.md` and `README.md`'s Deploy section — those
are accurate infra facts, not brand prose. Not swept: several `lore/` reference
docs still say "protoArch" in passing (see Open, above) — flagged, not done
silently.
Still open: long rank-skipping edges get a lonely lane; big graphs sprawl wide;
badge is a 20px target (small); trace + selection are independent; trace is
one-hop only (full up/down-stream chain would be a small change); the `lore/`
reference-doc sweep above.
Loaded: CLAUDE.md, GUARDRAILS.md, CONTEXT.md

### 2026-09-04 — JB / Claude — node standard + full design pass  (branch `polish/design-and-node-standard`)
JB: "think of urself as a senior designer and senior engineer and senior product
designer… fix any mistakes/holes… push whatever we have to main, cut a branch."
Pushed the pending lore to `main` (`5e8ee5d`), then built on a branch.

**Language — the node standard shipped.** New `src/fml/nodeTypes.ts` is the
single source of truth: five types — `page`, `api`, `decision`, `event`, `flow`
— each with a colour, a glyph, a summary, `expects` and `optional` keys. Design
call made while building: `expects` holds **only** keys without which the node
can't do its job (`api` → method + path/url, `flow` → doc). A page's `route` and
a decision's `condition` moved to `optional`, because `Login = page` must stay a
complete, correct node — a sketch language that nags is a worse sketch language.
Parser: off-standard type warns (errors in strict); strict also hints at missing
expected keys; kv key charset gained `.` so the execution-ready `header.<Name>`,
`query.<name>`, `capture.<var>` keys parse. `unknown` is reserved for
parser-invented nodes and never double-warns.

**Design pass.** Node cards rebuilt: type accent rail + per-type SVG glyph +
type tag, selected state glows in the type's own colour, `flow` nodes get a
stacked-card "there's a doc behind this" silhouette, untyped nodes go dashed,
`page` nodes render an `image:` thumbnail (http/data URLs only), long meta lists
collapse to "+n more". One React Flow node type (`fml`) instead of the old
page/api aliasing. Sidebar: collapsible (⌘\), selection-aware and two-way with
the canvas, per-type glyphs, file removal, doc/flow counts. Toolbar: Save,
Reset, sidebar toggle, focus rings. `fitView` now takes a padding object built
from the real chrome widths, so nodes stop hiding under the toolbar and panels.
Empty-canvas state. Esc clears selection.

**Holes closed.** Edge notes are editable in the property panel (`setEdgeNote`
in `fmlEdit.ts`, + 13 tests) — the last read-only corner of the write-back path;
found and fixed a latent bug where a note body line like `blocked:` could be
mistaken for a group header, by teaching the edge-line finder to skip note
blocks. Portal drill-down (fml-on-fml step 3): double-click a `flow` node to
jump to the doc its `doc:` key names. "Reset to sample" finally exists. The
sample file was rewritten to demonstrate the whole standard — all five types,
exec-ready `api` keys with `{token}` interpolation and `capture.`, an edge note,
and a second `@doc`. All `examples/*.fml` updated to parse clean under strict.
Docs: `README.md` was a single line — written properly; `CLAUDE.md` still
described the abandoned 2026-07 tech-tree concept — rewritten; `HOW-TO.md` gained
the type standard, the execution-ready `api` key section and the viewer's
capabilities.

134 tests green (89 parse / 16 stats / 29 fmlEdit), typecheck + build clean.

**Review pass (same day, after JB said "take a look… deploy it"):** verified in
the browser — 5 types render with per-type accent + glyph, property-panel edit
writes back to source (method → PUT round-tripped), flow-node double-click
drills into its doc. Fixed three things the render exposed: dagre used a flat
190×72 per node so tall `api` cards overlapped neighbours (now estimates height
from node data); auto-fit depended on the padding object, which changes on every
selection, so each node click animated the viewport (now padding is read from a
ref, fit only on graph change); edge stroke `#565656` was near-invisible on
`#1b1b1b` (→ `#6f6f6f` / 1.75px). Also stripped stray NUL bytes from
`toReactFlow.ts`'s pairKey separator that had made the file diff as binary.

**Merged to `main` (`8111524`) and deployed** — live at https://protoarch.web.app.
Branch `polish/design-and-node-standard` deleted.
NOT done: `public/index.html` dead Firebase boilerplate still there (JB's call);
`#`-in-value still eaten by the comment lexer (JB's call); no breadcrumb for
portal drill-down; sidebar has no resize.
Loaded: CLAUDE.md, GUARDRAILS.md, CONTEXT.md

### 2026-09-03 — JB / Claude (cont.) — property panel (edit → write .fml), dots, Lexend wordmark
Right-side **property panel** (`src/components/PropertyPanel.tsx`): click a node
or edge → its props show in a docked right panel, edits write straight back into
the `.fml` text. `src/lib/fmlEdit.ts` (16 tests, in `npm test`) does targeted
text surgery scoped to one `@doc`: `setNodeBlock` regenerates just that node's
`@node { }` block (covers label + every meta key + add/remove + type via
`setNodeType`), `setEdgeLabel` swaps the label on the matching flow line
(inline or grouped). Comments, other nodes, formatting are untouched. Writes go
to the right file — an `@fof`'d doc's edits land in *its* file
(`chart.doc.source`), treated as its own `main`. `useFmlChart` now also returns
the raw active `FmlDoc`; `FlowCanvas` reports selection via
`onNodeClick`/`onEdgeClick`/`onPaneClick`. Round-trip verified in browser
(edit method → file text + canvas update, comment preserved).
Also: background dots thicker/brighter (gap 20, size 2, `#3d3d3d`); sidebar
wordmark is now **"protoArch" in Lexend 400** (Google Fonts link in
`index.html`, `--font-brand` token); page `<title>` → protoArch.
NOT done: edge-note editing (panel shows notes read-only), node rename,
add/delete node or edge (structural — needs the FmlDoc→text serializer).

### 2026-09-03 — JB / Claude (cont.) — visual redesign
Full design pass. Palette lives as Tailwind v4 `@theme` tokens in `src/index.css`
(`--color-bg #1b1b1b` canvas, surface `#202020`, surface-2 `#242424`, elevated
`#2b2b2b`, `line` hairline, `ink`/`ink-dim`/`ink-mute` text, `accent #a78bfa`
violet, per-type page/api/flow/decision colours, `font-mono`). Dotted bg tuned.
Merged PageNode + ApiNode + NodeShell → one `src/components/nodes/FmlNode.tsx`
driven by `data.kind` via `src/lib/nodeStyle.ts` — rounded-xl card, hairline
border, colour tag chip, mono meta rows, dim handles. Sidebar / Toolbar /
SourcePanel / IssueList all restyled to the tokens (mono for code/paths/counts,
violet left-accent bar on active nav rows, type-colour dots on layer groups).
Edges: `#565656` stroke, mono label chips; primary label nudged 13% toward
source so it clears side-routed return labels; RF Controls + edge-hover styled
via `index.css`. Deployed. 77+16 tests green. Old node files deleted.

### 2026-09-03 — JB / Claude (cont.) — Figma-style sidebar + curved routed edges
Sidebar (`src/components/Sidebar.tsx`) — real docked left panel, full height,
canvas is `flex-1` beside it (pushed, not overlaid); App now wraps
`<ReactFlowProvider>` around a flex row. Sections: Files (if >1), Docs (replaces
the toolbar DOCS strip), and `<doc> — layers` (nodes grouped by kind, click →
`setCenter` on the live node via `getNode`, follows drags). Toolbar lost the
FILES/DOCS strips, back to one row.
Edge fix: side-routed reciprocal/parallel edges were drawn ~straight because
`getBezierPath` collapses to a near-line when same-side handles are vertically
colinear. `FlowEdge` now hand-builds a wide cubic C-curve that bows away from the
node by a fixed amount (`SIDE_BOW` 62 + tier) for `parallelIndex >= 1`; primary
edge (`index 0`) still uses `getBezierPath`. The `401`-style return now visibly
curves around the box. Verified in-browser, deployed. 77+16 tests green.
Rough edges still open: label crowding where a primary + a reciprocal return
share a node; fitView ignores toolbar height; sidebar has no collapse/resize.

### 2026-09-03 — JB / Claude (cont.) — @fof cross-file imports + viewer multi-file (fml-on-fml step 2)
`@fof <path> [as <name>]` — extension-less (JB: "it's also going to be fml so why
mention it"). `parse(src, { resolve })` with a sync `resolve(path, from)` the
caller supplies; no resolver ⇒ `@fof` warns+skips so bare `parse(src)` still
works. Recursion, circular-import error, depth cap 16, unresolved = error/warn by
mode. `FmlDoc.source` + `FmlIssue.file` added; cross-import name collisions →
`name_2` + warning. `demo.ts` got an fs resolver; `examples/fof/` (app→auth,
app→checkout→payment). Viewer: `Open .fml` is multi-select + multi-drop; state is
`Workspace { files, entry }` (localStorage `protoarque_fml_ws`, migrates the old
`protoarque_fml_source`); FILES strip picks the entry file, DOCS strip picks the
resolved doc to render; `useLocalStorage` gained functional-updater support.
30 new parser tests (77 parse + 16 stats green). Verified in-browser (app.fml
resolves auth/checkout/payment; DOCS strip switches graphs), deployed to
protoarch.web.app. Image on page nodes = `image:` text key (path/URL), still just
a free-form key, viewer render is a later standalone change. NOT done: portal
double-click drill-down + breadcrumb (step 3), `fml bundle` (step 4).

### 2026-09-03 — JB / Claude (cont.) — FML v0.2 multi-doc parser (fml-on-fml step 1)
Settled the format question: fml-on-fml uses **plain-text multi-doc**, NOT a zip
container — zip is for heterogeneous bytes (`.docx`), FML bundles homogeneous
text and wants a delimiter (`@doc <name>`). Shipped step 1: `@doc <name>` at
col 0 opens a doc; no `@doc` ⇒ one implicit `main` (every existing `.fml`
unchanged); lines before the first `@doc` seed `main`; node ids are doc-local;
repeated name → warn+merge; malformed → error. `FmlDoc` gained `name`; new
`FmlFile { docs }`. `ParseResult.file` is the whole file, `.doc` kept as alias
for `docs[0]` → zero churn on existing callers/tests. `analyzeFile()` added;
`demo.ts` prints per-`@doc`. 21 new tests (60 parse + 16 stats green), build
clean, `examples/multi.fml` added, viewer still renders `docs[0]` (no crash).
Not deployed — viewer has no doc UI yet.
Decisions: cross-file import directive will be `@fof` (JB's call); the portal
node key is `fof:` (same word, one concept); `image:` stays a text key on the
page node's block (path/URL, never base64) with `fml pack`/`.fmlpkg` as an
opt-in distribution artifact only. All in `lore/ideas/fml-on-fml.md`.

### 2026-09-03 — JB / Claude (cont.) — edge fan-out + 2 new ideas
Fixed overlapping edges: reciprocal pairs (A→B / B→A) and repeated same-pair
edges rendered as near-identical stacked bezier curves with colliding labels.
New `src/components/edges/FlowEdge.tsx` (custom edge, registered as type `flow`):
groups edges by unordered node pair in `toReactFlow.ts`, fans each set apart with
a perpendicular offset canonicalised by node id (so both directions spread along
one screen axis), staggers labels along the curve. Lone edges keep the plain
bezier — no regression. Verified in-browser (Chrome screenshot), redeployed to
https://protoarch.web.app. 39+12 tests green.
  *Follow-up same session:* first pass still criss-crossed a long diagonal
  reciprocal pair (SignIn ⇄ authSession) — the old maths put both control points
  on the SAME side (the `*flip` on the perpendicular and the rank sign cancelled)
  and staggered labels along each edge's own direction so both labels bunched at
  one node. Rewrote FlowEdge: canonical A/B endpoints by node id, pure canonical
  perpendicular (no flip), bow scales with edge length, labels slide along the
  canonical A→B axis (not per-edge t). Re-verified in-browser, redeployed.
  *Follow-up 2:* the bowed return edge still passed THROUGH/behind the node box
  (JB: "409 line is going behind the api node… don't want lines behind or over
  nodes"). Switched to real routing: `NodeShell` now renders source+target
  handles on all 4 sides (primary pair visible, rest invisible/connectable);
  `toReactFlow` sends the primary edge of a pair out the main sides and every
  extra edge (reciprocal / repeat) out a side handle (`s-right`/`t-right` in TB,
  alternating), so it loops AROUND the stack. `FlowEdge` now just uses
  `getBezierPath` from the handle positions; a small bow is kept only for the
  3rd+ edge that reuses a side. Verified: 409 routes clear of the box.
  Redeployed. 39+12 tests green.
New ideas captured from JB: `lore/ideas/outline-sidebar.md` (Figma-style node-by-
type panel, cheap, no language change — do first) and `lore/ideas/fml-on-fml.md`
(portal node linking to a sub-flow; blocked on the multi-diagram refactor,
same-file v1 recommended before any cross-file workspace).

### 2026-09-03 — JB / Claude (cont.) — first deploy + shop.fml
Deployed the viewer to Firebase Hosting: project `protoarch`, site `protoarch`,
live at https://protoarch.web.app (custom domain proto.arque.app not wired yet —
DNS step, separate). `firebase init` had left `firebase.json` `"public": "public"`
pointing at the stock Firebase placeholder — changed it to `"dist"` (Vite's build
output). `public/index.html` (the boilerplate) is now unused; left in place, JB to
delete if he wants. No `predeploy` build hook yet — deploy = `npm run build` then
`firebase deploy --only hosting`. Added `examples/shop.fml` — the fullest example
(14 nodes incl. a `decision` type, 20 edges, 4 edge notes, `label:` on every
endpoint).

### 2026-09-03 — JB / Claude (cont.) — FML v0.2 edge notes
JB greenlit edge notes with a tight spec. Implemented the parse layer:
`FmlEdge.data?: Record<string,string>`; edge line may end with `{`, opening a
`key: value` block closed by a lone `}` (mirrors `@node x {`), on both inline and
grouped arrows. `addEdge` now returns the created edge so `consumeEdgeNote()`
attaches `data` to the exact arrow (never matched by src/target after the fact).
Pass 4 loop is now index-based. Unclosed block → error on the arrow line's
number; next flow line never swallowed. 6 new parser tests (39 green), 12 stats
green, typecheck + build clean. `examples/*.fml` parse identically. HOW-TO.md got
a real "Edge notes" section + gotchas/error-table/checklist rows.
Deliberately NOT done (out of scope, needs separate go-ahead): canvas rendering
of edge notes — `toReactFlow.ts` still drops `edge.data`; needs a custom edge
component. Tracked in `lore/ideas/edge-notes.md` → Follow-up.
Sharp edge left as-is: `#` after a space is a lexer comment, so `note: ... #114`
loses `#114` (same as `@node` bodies). Documented, not changed.

### 2026-09-03 — JB / Claude
Session "fml". An external agent used FML on a real app and reported back. Three
"missing capabilities" turned out to be real capabilities the docs undersold —
fixed `HOW-TO.md`: (1) any `@node` key renders on the box, added `note:` example;
(2) non-`page`/`api` types render as a grey tagged box, not "default page style"
(old doc claim was wrong); (3) promoted `demo.ts` as the no-canvas structural
self-check, with real sample output + a "what each line catches" table.
Code change: `label:` in a `@node` block now overrides the displayed name and is
stripped from the metadata list (`toReactFlow.ts`). Typecheck + 37 tests + build
green. One genuine gap — edges can't carry a `note`, only a short label — written
up as `lore/ideas/edge-notes.md` (v0.2 block syntax mirroring `@node`), proposed
to land BEFORE the multi-diagram refactor. Awaiting JB review.
Loaded: CLAUDE.md, GUARDRAILS.md, CONTEXT.md
Carry forward: header above was stale (still described the old tech-tree concept
from 2026-07-24 — FML pivot happened across intervening sessions); rewrote it.

### 2026-07-24 — JB / Claude
Initialized protoarque — a canvas-based tech tree / roadmap builder inspired by game progression maps (Minecraft tech trees, ONI research, Dr. Stone roadmap). Vision: drop nodes with icons/labels onto an infinite canvas, draw directed connections, toggle acquired state on nodes. Stack decided: Vite + React + TypeScript + @xyflow/react + Tailwind + localStorage + Firebase Hosting (proto.arque.app). No backend. lore scaffolded from scratch, CLI session registered as PAQ (f896f6b0).
Loaded: none (init session)
Left open: Vite project not yet bootstrapped, Firebase project not created
Carry forward: JB wants to plan properly before building — confirm feature scope before writing code
