# Lore + F*ML audit from the Flock v2 build (2026-10-13)

Source: a Claude "Development Manager" run that delegated all code to agy/codex and used lore and F*ML. Companion playbook: copy of `agentic-dev.md` in this folder. Everything here is observed, not hypothetical.

## What worked
- **Lore:** survived a full context compaction mid-build (contracts, CONTEXT log and tickets were on disk); features/*.md made "done" checkable and packets could point at them; GUARDRAILS held; the session hook and `lore ticket` CLI kept load/update cost low.
- **F*ML:** `.fml` flows are readable and double as docs; runner has the right controls (`--dry`, `FML_VAR_*`, exit 0/1); contract-first drafting worked (flows existed before the API).

## What hurt
Lore: CONTEXT.md grows without bound (198 lines); tickets drifted (FLK-77..80 stayed "inprogress" long after done); docs and code drift with nothing checking; `lore ticket done <ID>` needed the session id and failed without it when cwd was not the project root; no link between a ticket and its contract/flow/test/commit; nothing prompts the manager to write back after a slice.
F*ML: asserts status codes only, so every bug that actually bit the build was invisible to it (weak-ETag conditional GET returned 200 not 304; catalog bytes re-serialised and stripped; byte-exact decrypt; Range 206/416 behaviour); the flows were never run as a gate (gates were vitest, a verify script, curl, Playwright); API-only, no UI/device step; no drift check between flows and the real API (catalog.fml described endpoints that were later built differently); tokens passed by hand.

## Feature requests (ranked)
F*ML: header/body/byte assertions; conditional + range requests as first-class with header capture; machine-readable JSON result; UI step type (browser/simulator); OpenAPI drift report; secrets-from-env store; run as a gate against a deployed staging URL.
Lore: contract linking (feature doc lists flows/tests/tickets); done-gate running linked commands; auto-archive/summarise CONTEXT.md; `lore packet` scaffold for agent work packets; docs-vs-code drift check; session resolved from cwd; stale-ticket detector; end-of-slice write-back prompt.
