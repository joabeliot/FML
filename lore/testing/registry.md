# Test Registry — F*ML

Three layers. None of them needs the internet: the CLI and e2e suites start
their own fixture API (`scripts/testkit/fixtureServer.ts`) and the e2e suite
starts its own Vite server.

| Command | What runs | Time |
|---|---|---|
| `npm test` | 11 unit suites + the CLI suite | ~5 s |
| `npm run test:e2e` | the dashboard and browser-driving CLI, end to end (Playwright + Chrome) | ~40 s |
| `npm run test:all` | `npm test` + `npm run build` + `npm run test:e2e` | under a minute |

**Rule:** a feature adds its checks to the matching layer, and a bug fix
adds the test that would have caught it. Run `test:all` before any release
and after any change to `src/components`, `src/hooks` or `src/App.tsx`.

## Unit: `npm test` (plain Node scripts, no framework)

| Area | Test file | Notes |
|------|-----------|-------|
| Parser | `src/fml/parse.test.ts` | sections, `@doc`/`@fof`, edge notes, strict mode |
| Stats | `src/fml/stats.test.ts` | flows, entry points, terminals |
| Variables | `src/fml/variables.test.ts` | `{name}` resolution, `@vars`, captures, `ask.<name>` |
| Engine | `src/fml/run.test.ts` | interpolation, `readPath` (`.length`, `body.sha256`/`bytes`), statuses, requests, captures, `assert.*` grammar incl. page reads, header/ETag asserts, conditional GET vs fake origins, Range, **ui steps with a fake `UiDriver`** (action order, `fill.<field>`/`sel()`, captures, asserts, screenshot, skip without driver, walk rules, `examples/ui.fml` end to end), routing, guards, **asking a person (FML-26)**: pause then asks in order, secret detection, supplied-up-front skip, cancel, no handler, throwing handler, prompt interpolation |
| Lint | `src/fml/lint.test.ts` | typo'd keys, base checks, malformed asserts, ui-node checks, listed examples lint clean |
| Run report | `src/fml/report.test.ts` | shape, failure classification, value redaction, truncation, `.fml.env` parsing |
| Spec drift | `src/fml/drift.test.ts` | path/method matching, base prefixes incl. `{var}` bases, status coverage, multi-host skip, multi-doc, junk spec |
| Roadmap layout | `src/lib/radialLayout.test.ts` | centre root, one grid step per edge (octilinear), outward growth, deepest-prerequisite parent, no shared cells (incl. the example), cycles, area grouping |
| RML | `src/rml/rml.test.ts` | RML vocabulary on FML's parser, status/ready/locked, checks incl. cycles, `examples/roadmap.rml` |
| Write-back | `src/lib/fmlEdit.test.ts` | targeted surgery keeps comments/formatting, incl. flow lines with a trailing `# comment`; `@vars` add/change/remove/rename |
| Structural edits | `src/lib/fmlStructure.test.ts` | add/delete/rename node, add/delete edge, doc-local, no-ops; deletes and renames every node in every example |
| Data wires | `src/lib/dataWires.test.ts` | ports, one port per name, wires, sources, variable nodes + their wires, ports always visible, drop options |
| **CLIs** | `scripts/cli.test.ts` | `run.ts` as a process: pass/fail exit codes, missing inputs, `--var`/`FML_VAR_`/`FML_SECRET_`, `.fml.env` + `--secrets` (incl. errors), redaction in log/plan/report, `--dry` sends nothing, `--json` failure kinds, `--fail-fast`, `--report`, **ask/pause** (piped answers via `FML_ASK=stdin`, prompts on stderr, answer redacted, `q` cancels, non-interactive fails, `--yes`, `--json` records `asked`); `drift.ts` JSON/YAML/exit codes/coverage/usage; `demo.ts` lint and parse errors |

## End to end: `npm run test:e2e` (`scripts/e2e.ts`)

Each scenario runs in a fresh browser context and fails on any console
error, React Flow warning or failed request (except the favicon).

| Scenario | Checks |
|---|---|
| Sample + portals | sample draws; portal expands inline; **double-click drills into the doc** |
| Source + property write-back | typing in Source redraws; a panel edit lands in the `@node` block; comments survive |
| Structural editing (FML-22) | + Node declares and selects; rename rewrites; taken id refused; **drag handle → card** makes an edge; dropping exactly on a handle makes one, not two; label; Delete; Ctrl+Z; panel Delete cascades without touching the rest |
| Variables (FML-27) | ports show with nothing selected; @vars + run-time inputs are nodes; + Node → Variable; rename + value via panel; drop on an input port repoints the reference; delete |
| Data wires (FML-20) | none when off; selection shows a node's wires; Data shows all; drag port → card → picker writes `auth: bearer {token}`; new wire drawn |
| Roadmap (FML-21, FML-28) | example loads (20 tiles, 3 NEXT); status change; + Feature unlocked by the selection; rename; description; kind switch; drag link handle adds a dependency; loop refused; Delete; Ctrl+Z; view switching clean; New roadmap grows from `start` |
| Asking a person (FML-26) | asked value isn't requested up front; dialog mid-run, WAITING FOR YOU; masked secret; pause at the next node; Continue → PASS; Stop run → FAIL "you stopped it at me" |
| In-app run | two api steps pass through the dev proxy against the fixture API; ui step shows skipped `–` |
| ui steps from the CLI (FML-19) | real Chrome against a fixture form: `fill.<field>` and `sel()`, captures, screenshot saved; wrong assert → JSON `kind: assert`; missing element names the action |

## Bugs these suites have already caught

- `drift` treated a variable base (`base: {apiBase}`) as a path segment. Found by the CLI suite.
- Data wires (FML-20) rebuilt every canvas node on each selection change, which swallowed the double-click that opens a portal. Found by e2e and bisected to FML-20.
- A wire dropped on an input port sometimes opened the field picker instead: React Flow snapped to the control-flow handle beside the port. Found by e2e as a 1-in-3 flake.
- Connecting by dropping on a card (not exactly on its handle) did nothing; React Flow only connects within ~20px of a handle. Found by e2e as a zoom-dependent flake.

## Not covered

- Visual appearance (colours, layout pixels). The e2e suite checks behaviour and file text, not looks.
- Live network examples (`examples/*.fml` against httpbin / jsonplaceholder). Run them by hand: `node scripts/run.ts examples/<file>.fml`.
