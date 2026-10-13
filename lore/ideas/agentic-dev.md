# Agentic development playbook (learned on Flock v2, Oct 2026)

Written by Claude (the "Development Manager") for JB, so the same way of working can be copied to other projects. Everything below happened on this project; where I have no measurement I say so.

## 1. The operating model
- **Three roles.** JB = CTO (decides what and why). Manager (Claude Code) = plans, writes work packets, launches and watches agents, runs every check, reports honestly. **Builders** (agy = Antigravity CLI, codex) = write the code. The manager never hand-writes application code, so its context stays free for planning and verifying.
- **Why split it.** Writing code and judging code are different jobs. If the same head does both, it grades its own homework. The manager only has the contract and the checks, so it is a fair judge.
- **Fallback.** Codex hit its usage limit mid-project. Backend work moved to agy, which cannot run commands, so the manager ran all builds and tests for it. Plan for one builder being unavailable: keep packets tool-agnostic.

## 1b. The two foundation blocks: lore and F*ML
The model above only works because of these two. Lore is the memory and the contract; F*ML is the executable check. Everything else (packets, gates) hangs off them.

**Lore = memory + contract layer** (`lore/` at the repo root, loaded at session start by a hook).
- `features/*.md`: the contract written before any code ("done means" list). Packets and checks point at it.
- `GUARDRAILS.md`: standing rules (staging only, no commits unasked, never touch legacy Firebase, never hand-edit protected files). Loaded every session, treated as real rules.
- `CONTEXT.md` + tickets (`lore ticket`): current state and the running log. This is why a context compaction mid-build lost almost nothing.
- `decisions/` (ADRs): settled choices, so nobody re-argues them without a named trigger.
- `testing/registry.md`: what is covered and by which test.
- `OG.md` and `MISSION.md` are human-only: the manager and the builders never edit them.
- Discipline: read lore before substantive work; update lore first when it disagrees with instinct; write back after every slice, not at the end of the session.

**F*ML = the executable contract** (the diagram becomes the test: a flow that runs, threads captured values between steps and asserts each response).
- Every feature contract gets a `.fml` flow against the real environment. "Done" means the flow passes, not just that unit tests do.
- Flows in flockApi: `tests/fml/{prototype,catalog,events,negative,sync,admin-publish}.fml`. The prototype flow covers health, catalog, the conditional-GET 304, media descriptors, a ranged read, "keys are blocked" and a bad media id.
- Good first assertions are the ones unit tests missed on this project: weak-ETag 304, served bytes equal stored bytes, range and 416 behaviour, forbidden paths return 404.
- **Honest status:** on Flock v2 the `.fml` files existed as specs, but the gates actually run were vitest, `verify-remote`, curl and Playwright. The flows were not run through the F*ML runner (no `fml` on PATH; runner support for a remote base URL is unconfirmed). Fix this before relying on it: make the manager run the flows as a gate, the same way it runs analyze and tests.
- Builders never mark a flow green; the manager runs it.

How they combine: lore says what must be true (contract), F*ML proves it against the live system, the manager owns both gates, and the result is logged back into lore.

## 2. The loop (per slice of work)
1. **Contract first.** Write a feature doc in `lore/features/` before any code: data shapes, endpoints, file layout, "done means" list, plus the `.fml` flow that will prove it. Builders and tests both point at it. (`catalog-on-r2-prototype.md`, `dashboard-v0.md`.)
2. **Packet.** One small task per packet (see section 3).
3. **Launch** headless, output to a file, `< /dev/null`, generous timeout. Monitor by reading the output file, not by guessing.
4. **Verify independently.** Read the diff. Run format, analyze, typecheck, unit tests. Never accept "I updated X, tests pass" from a builder. Builders cannot run tests anyway, so any claim of a green run is not evidence.
5. **Exercise it for real** (section 5): run the slice's `.fml` flow against staging, then use the real UI/device. This step found most real bugs.
6. **Fix by new packet**, not by hand. Small failures get a tiny packet with the exact evidence (log line, screenshot, failing assertion).
7. **Log**: tickets (`lore ticket`), `lore/CONTEXT.md`, test registry, memory files. Do it as you go, not at the end.

## 3. Writing a good packet (what worked)
- **Common context block** at the top: repo root, "use only file read/edit tools inside this repo", "never run shell commands", "edit first, then reply with a 3-line summary", "only real identifiers, open files before editing".
- **Exact path manifest.** Headless agents cannot list directories. Give the files to open and the files allowed to change. "Do not touch other files" is the most useful sentence in the packet.
- **Evidence, not vibes.** For fixes: what was observed, the suspected cause, the smallest change. Example: "`main_ui.dart` builds the repository without a cache, so nothing is persisted. Pass `cache: CatalogDiskCache()`. Do not change the constructor default."
- **State what must not change.** Constructor signatures, public API, existing behaviour, test conventions (no `pumpAndSettle`).
- **Tests inside the packet**, named: which file, which cases, no real network.
- **Parallelism by disjoint files.** Run two agents at once only when their file manifests do not overlap. Otherwise serialise.
- **Never reference files outside the repo.** A denied read aborted a whole run. If outside material matters, copy it into the repo first.
- **One task per packet.** Agents drift when a packet has five goals.

## 4. Builder quirks (agy headless)
- No shell: every network error, permission denial or "command not allowed" aborts the run silently. Add "do NOT run shell commands" and "edit first" to every packet.
- It follows the manifest well and invents little when identifiers are real. It invents when asked to remember.
- It formats loosely: always run `dart format` / the project formatter yourself afterwards.
- A flaky connection (travelling) caused repeated network errors. Wait for a stable network before long runs.

## 5. Verification: what actually catches bugs
Unit tests and green gates were necessary but not sufficient. Bugs found only by using the real system:
| Bug | Why tests missed it | What found it |
|---|---|---|
| Conditional GET never returned 304 through Cloudflare | edge rewrites ETag as weak (`W/"..."`); in-memory test used exact match | `curl` against the live Worker |
| Catalog re-serialised and stripped unknown fields | schema re-parse in the read path; fixtures had no extra fields | comparing live bytes to the stored object |
| App had no disk cache wired, so no offline start | repository default is "no cache" (tests rely on it); entrypoint forgot to pass one | inspecting the app container on the simulator |
| Saving a track reset the drawer, so uploads were lost | effect depended on object identity | driving the real dashboard in Chrome |
| Buttons went blank while busy | white spinner on a white disabled button | screenshot |
| Two writes clobbered the draft | read-modify-write without a lock | firing parallel uploads |
| Release preview ignored tracks | diff only compared albums | reading the preview as a user |
Rules that follow:
- **Test against the real deployed thing at least once per slice** (live API, real device or simulator, real browser). Playwright driving real Chrome worked when the browser extension was not connected; `xcrun simctl` + mobile-mcp for the simulator.
- **Verify bytes, not responses.** Decrypt the uploaded media from the live server and compare the hash.
- **Look at screenshots yourself** before reporting a UI as done.
- **Clean up after your own tests.** A test script left a stray published track ("Dup Probe") that blocked a real release. Give test data an obvious prefix and delete it in the same session, or use a separate album.

## 6. Efficiency: what helped, what cost time
Helped:
- Contracts before code: builders rarely had to guess, so rework was small.
- Small packets with a "do not touch" list: diffs were easy to review.
- The manager owning all gates: one place decides "done".
- Caching/mutex fixes driven by measurements (a dashboard call took ~6 s through wrangler; warm cache ~0.01 s).
- Tickets + CONTEXT + memory: a compaction mid-project lost almost nothing.
Cost time:
- Builder cannot run code, so every fix is a round trip through the manager.
- Quota limit on one builder; flaky network; a classifier blocking a cleanup (see section 7).
- My own test-script bugs (wrong field names, waits too short).
Measured outcomes (counts only, no timings recorded): prototype end to end plus dashboard v0 built in one night; at the end Flutter 140 tests, flockAdmin 79, flockApi 19, all analyze/typecheck clean. I did not time individual packets, so do not quote speed-up numbers from this document.

## 7. Safety and trust
- **Destructive or shared-state actions need confirmation every time**, even when the user already said yes in chat. Here the auto-mode classifier blocked deleting test data and rolling back the live catalog twice. The right response was to stop, explain, and hand JB two options (do it himself in the UI, or add a permission rule). Do not look for a workaround.
- Staging only until the user says production. Never print secrets or keys. Never commit or push unasked.
- **Report faithfully.** Say what was verified and what was not (Android untested, rollback UI unexercised, cover art not yet checked offline). Correct yourself in the open: I wrongly blamed the validator for a release block that was caused by my own leftover test track.

## 8. Checklist to start a new project this way
1. Create `lore/` (GUARDRAILS, CONTEXT, features, decisions, testing/registry; only with the owner's approval). Write the standing rules down. Install F*ML and confirm the manager can run a flow against a remote base URL.
2. Write the first feature contract with a "done means" list and the `.fml` flow that proves it.
3. Break into slices; each slice = packet(s) + gates + one real-world check.
4. Pick builders, note their limits (shell? quota?), pick the gate commands the manager will run.
5. Set up the real-world harness early: staging environment, a way to drive the UI (Playwright / simulator), a way to hit the API (curl / verify script).
6. Keep tickets, CONTEXT log and memory current after each slice.
7. End each session with: what is verified, what is not, what needs the user's decision.

## 9. Open questions
- How much of the Android path will be clean (not yet built)?
- Should the manager also write the test-data cleanup as part of every packet? (I think yes.)
- Can the F*ML runner run flows against a deployed staging URL with captured variables? Needed to make it a real gate.
- Hermes (notifications) could page JB when a long agent run finishes or a gate fails. Not set up.
