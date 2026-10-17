# UI steps: drive a browser inside a flow (FML-19 design)

Status: **built (2026-10-17), signed off by Joab.** The open questions went
with the leanings below: a new `ui` type, Playwright, screenshots on disk.
One change from this design while building: keys can't hold CSS selectors
(the key charset is `[A-Za-z0-9_.-]`), so it's `fill.<field>` (name / id /
data-testid) with a `sel(<css>)` value prefix for anything else, rather than
`fill.<selector>`. Playwright became a devDependency, because the dashboard
end-to-end tests use it too. HOW-TO has the user-facing reference.

## Why

Most of the Flock v2 UI bugs (the drawer resetting, a blank busy button, the
preview ignoring tracks) only showed up when someone drove the real UI. An
FML flow stops at the API boundary today. The ask is one flow that goes
API → dashboard → app: create something through the API, then check that
the UI shows it.

## Shape: a new node type, `ui`, with an injected driver

This mirrors how `api` works. `run.ts` never touches the network; the
caller passes a `Transport`. A `ui` node would work the same way: `run.ts`
never touches a browser, and the caller passes a `UiDriver`. That keeps
`src/fml/` dependency-free and lets the engine be tested with a fake driver,
exactly like the HTTP side.

```
@node openDashboard {
  open: {dashboardUrl}/items/{itemId}     # navigate (relative to @meta ui_base)
  wait: [data-testid=item-title]          # until visible
  assert.text.[data-testid=item-title]: {itemName}
  capture.status: text([data-testid=status])
  screenshot: item-page
}

@node clickPublish {
  click: button:has-text("Publish")
  wait: [data-testid=toast]
  assert.text.[data-testid=toast]: matches ^Published
}
```

- **One action group per node.** A block's keys are a map, so a node can't
  hold two `click`s in order. Each node does: `open` → `fill.<selector>` →
  `click` → `wait`, then `capture`/`assert`, then `screenshot`. A longer
  journey is a chain of `ui` nodes, which is also how it reads on the
  canvas.
- **Keys:** `open`, `click`, `fill.<selector>`, `wait`, `press`,
  `screenshot`. `capture.<var>` and `assert.<path>` reuse the existing
  machinery, with the path read from the page (`text(<sel>)`, `count(<sel>)`,
  `url`, `title`) instead of from a response. `{name}` works everywhere,
  so an id captured by an `api` node flows straight into the URL a `ui` node
  opens.
- **Routing:** a `ui` node has no status code, so after it the walk takes the
  lone or unlabelled edge, like a `page` node does today. A failed `ui` step
  is red, and `--fail-fast` stops on it.
- **Selectors:** Playwright's syntax, since that's the driver. Note that `#`
  in a value is eaten by the comment lexer, so `#id` selectors need
  `[id=…]`. That's the same open `#` question as before, and it matters more
  here.

## Drivers

| Where | Driver | Notes |
|---|---|---|
| CLI (`scripts/run.ts`) | Playwright, **optional**: `import("playwright")` only when the flow has a `ui` node; if it isn't installed, a clear "npm i -D playwright, npx playwright install chromium" | headless by default, `--headed` to watch; screenshots go to `--artifacts <dir>` and their paths land in the `--json` report |
| Browser app | none | a page can't drive another browser; `ui` steps show as "CLI only" and are skipped with a note (not failed) |
| Simulator (later) | a second driver (Maestro or `xcrun simctl` + XCUITest) with the same `UiDriver` interface | the language doesn't change; only `open`'s meaning does (deep link vs URL) |

Playwright is currently 1.64.x. It would be a devDependency used by
`scripts/` only, never by `src/fml/`.

## Scope for a v1, if signed off

1. `ui` in `nodeTypes.ts`, lint for its keys, renderer glyph and colour,
   HOW-TO, and an example. (A language change ripples, per CLAUDE.md.)
2. A `UiDriver` interface plus `ui` handling in `runNode`, with a fake-driver
   test suite.
3. A Playwright driver in `scripts/`, loaded lazily, plus
   `--headed` / `--artifacts`.
4. The report gets screenshot paths per step.
5. An example against a public demo page (no auth), so it runs anywhere.

Not in v1: simulators, auth/session reuse beyond cookies in one run, running
`ui` steps from the in-app runner.

## Open questions for sign-off

1. Is a node type (`ui`) right, or should these be `page` nodes that gain
   execution keys? (A `page` already *is* "something a person sees". Making
   it executable avoids a sixth type, but changes what `page` means for
   every existing diagram. Leaning towards a new `ui` type.)
2. Is Playwright acceptable as the first driver?
3. Should screenshots be artifacts on disk only, or also embedded (base64)
   in the `--json` report? (Leaning disk only, with paths in the report.)
