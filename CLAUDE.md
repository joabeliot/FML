# F*ML — CLAUDE.md

**FML — a Flowchart Markup Language for app flows**, plus the web viewer/editor
that draws it. You write `.fml` (navigation + API journeys as plain text); the
app parses it, lays it out, and lets you edit node/edge properties straight back
into the source file.

**Deploy target:** protoarch.web.app via Firebase Hosting (project `protoarch`, serves `dist/`)
**Repo:** github.com/joabeliot/FML

> The north star is **executable flows**: run an API journey from the diagram as
> a test — variables, captured values, status assertions. **The engine is built**
> (`src/fml/run.ts`); flows run from the CLI today. What's missing is the
> in-app UI. See `lore/ideas/flow-execution.md`. Design new language features to
> be compatible with it.

## Stack

- **Runtime:** Vite 6 + React 19 + TypeScript (strict)
- **Canvas engine:** @xyflow/react v12 + @dagrejs/dagre
- **Styling:** Tailwind v4 — `@theme` tokens in `src/index.css`, no config file
- **Persistence:** localStorage (the workspace is `{ files, entry }`)
- **Hosting:** Firebase Hosting (static)
- **No backend. No auth. No database.** Everything lives in the browser.
- Node 22 runs `.ts` directly — tests and `scripts/demo.ts` need no build step.

## Layout

| Path | What lives there |
|---|---|
| `src/fml/` | The language. Parser, node-type standard, stats. **Zero dependencies** — keep it that way, it has to run in Node and the browser. |
| `src/fml/nodeTypes.ts` | The canonical node vocabulary (`page`/`api`/`decision`/`event`/`flow`/`ui`) and their expected keys. Changing it changes the language. |
| `src/fml/variables.ts` | `{name}` resolution — `@vars` defaults + `capture.<name>` on an earlier node in the same doc. Per-doc scope; cross-doc (through a `flow` portal) is an open question, not decided. |
| `src/fml/run.ts` | The execution engine — sends `api` nodes, threads `capture`d values, asserts `expect`, routes on status. **Takes its transport as an argument** — never call the network from in here, that's what keeps it testable and CORS-agnostic. |
| `src/fml/assert.ts` | The `assert.<path>` comparison grammar — parse (for lint) and evaluate (for the runner). |
| `src/fml/report.ts` | The machine-readable run report (`--json`/`--report`) and value-based secret redaction. Pure — the CLI decides where it goes. |
| `src/fml/drift.ts` | Flow ↔ OpenAPI drift: unknown paths/methods, undocumented statuses, coverage. Takes the spec as an object; `scripts/drift.ts` reads JSON/YAML (the `yaml` devDependency lives there, never in `src/fml/`). |
| `scripts/uiDriver.ts` | The CLI's `UiDriver` (FML-19): Playwright behind `run.ts`'s interface, loaded only when a flow has a `ui` node. Bundled Chromium, else the machine's Chrome. |
| `scripts/run.ts` | CLI runner (`npm run run-flow -- <file.fml>`). Node has no CORS, so flows execute today. `--dry` prints the request plan. |
| `src/fml/lint.ts` | Semantic checks on a parsed doc — typo'd keys, unrunnable paths, malformed `expect`. Keyed by node id, not line, so the canvas can point at them. |
| `src/lib/httpTransport.ts` | The browser's transport. Dev routes through `vite/devProxy.ts`; the built site calls `fetch` directly and therefore only reaches CORS-permissive APIs. |
| `vite/devProxy.ts` | Dev-server request forwarder. `apply: "serve"` — it never ships, so the deployed site stays backend-free. |
| `src/lib/fmlStructure.ts` | Structural edits — add/delete/rename a node, add/delete an edge — as surgical text splices, same rule as `fmlEdit.ts`. See `lore/features/structural-editing.md`. |
| `src/lib/dataWires.ts` | Data wires (FML-20): capture → `{name}` ports and wires read from a doc, plus where a dropped wire can go. Read-only over the language — see `lore/features/node-sockets.md`. |
| `src/lib/fmlEdit.ts` | Write-back: targeted text surgery into one `@doc`'s span. Never re-serialises the whole file — comments and formatting must survive. |
| `src/rml/` | RML — the roadmap language (FML-21). FML's grammar parsed with `RML_VOCABULARY`; status/display/checks. Zero dependencies, same rule as `src/fml/`. See `lore/features/rml.md`. |
| `src/lib/` | layout (dagre), toReactFlow, node styling |
| `src/hooks/useForceLayout.ts` | Repulsion physics layered on dagre's rank layout (nodes never overlap, react live while dragging). Dagre still owns structure — rank, back-edge routing, badge order; this only refines pixel position in `FlowCanvas`. |
| `src/components/` | canvas, sidebar, toolbar, property panel, source editor |
| `examples/` | Reference `.fml` files. **All must parse clean under strict mode and lint clean** (`node scripts/demo.ts <file>`). `roadmap.rml` must parse clean under strict with `RML_VOCABULARY` and pass `checkRoadmap` (asserted in `rml.test.ts`). |

## Working rules

- **Run `npm test` and `npm run build` before saying anything works.** For any
  change that touches the dashboard (components, hooks, canvas, App), or a
  release, run **`npm run test:all`**, which adds the end-to-end suite. Three
  layers, all no-internet (see `lore/testing/registry.md`):
  - `npm test`: 13 fast suites: the unit suites under `src/` (parser, stats,
    variables, run, lint, report, drift, rml, fmlEdit, fmlStructure,
    dataWires, radialLayout) plus `scripts/cli.test.ts`, which runs the real CLIs
    (`run`, `drift`, `demo`) against a local fixture API.
  - `npm run test:e2e`: `scripts/e2e.ts` starts its own Vite server and
    fixture API, drives the real app in Chrome with Playwright, and checks
    the **file text** after every edit. It fails on any console error or
    React Flow warning. Add `--headed` to watch.
  - A new feature adds its own checks to the matching layer, and a bug fix
    adds the test that would have caught it.
- **`npm run demo -- <file>` is the structural check** when you can't see the canvas.
- **Language changes ripple.** A new node type or key touches the parser, the
  renderer, the property panel, `HOW-TO.md` and the examples. Do all of them.
- **Every Firebase deploy is paired with a git commit + push to `main`.**
- Never use `any`. Never add a dependency to `src/fml/`.

## Session Rule

At the start of every session, load these files in order:
1. `lore/INDEX.md`
2. `lore/GUARDRAILS.md`
3. `lore/CONTEXT.md`

Load Tier 2 files only when the task requires them. Announce which files you loaded.

At the end of every session:
1. Rewrite the `CONTEXT.md` header (Focus / Phase / Open / Next)
2. Append a log entry
3. Update tickets via `lore ticket` CLI — never edit `ticket.json` directly
4. Update any `features/`, `decisions/`, or `testing/registry.md` that changed

## lore Index

| File | When to load |
|------|-------------|
| `lore/architecture/overview.md` | Making structural changes to the canvas or data model |
| `lore/architecture/models.md` | Changing node/edge data shapes |
| `lore/ideas/flow-execution.md` | Anything touching variables, `api` keys, or execution |
| `lore/features/[name].md` | Working on that specific feature |
| `lore/testing/registry.md` | Writing or reviewing tests |
| `lore/decisions/` | Making or revisiting a significant decision |
