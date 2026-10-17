# Test Registry — F*ML

`npm test` runs every suite below in order; each is a plain Node script
(`node <file>`), no framework. `npm run build` (tsc + vite) is the other gate.

## Covered

| Area | Test file | Type | Notes |
|------|-----------|------|-------|
| Parser | `src/fml/parse.test.ts` | unit | sections, `@doc`/`@fof`, edge notes, strict mode |
| Stats | `src/fml/stats.test.ts` | unit | flows, entry points, terminals |
| Variables | `src/fml/variables.test.ts` | unit | `{name}` resolution, `@vars`, captures |
| Engine | `src/fml/run.test.ts` | unit, fake transport | interpolation, `readPath` (incl. `.length`, `body.sha256`/`body.bytes`), status matching, request building, captures, `assert.*` grammar + evaluation, header asserts (weak ETag), conditional GET against fake origins, Range/206/416, routing, guards |
| Lint | `src/fml/lint.test.ts` | unit | typo'd keys, base checks, malformed asserts, listed examples lint clean |
| Run report | `src/fml/report.test.ts` | unit, fake transport | report shape, failure classification, value-based redaction, body truncation, `.fml.env` parsing |
| Write-back | `src/lib/fmlEdit.test.ts` | unit | targeted text surgery survives comments/formatting |

Live checks (network, not in `npm test`): `node scripts/run.ts` on
`examples/run.fml`, `multi-host.fml`, `branching.fml`, `conditional-get.fml`,
`bytes.fml` should PASS; `examples/assertions.fml` should FAIL at `getPosts`
(on purpose).

## Not Covered

- React components and hooks (canvas, property panel, run bar)
- `scripts/run.ts` CLI flag handling (exercised by hand only; not in `tsc -b`)
- Browser transports (`src/lib/httpTransport.ts`) — the dev proxy was checked by hand

## Known Gaps

- Visual/interaction testing (canvas) is difficult to unit test — React Flow internals; prefer E2E (Playwright) when coverage is added
