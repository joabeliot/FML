# F*ML

**FML — a Flowchart Markup Language for app flows.** Write your navigation and
API journeys as plain text; F\*ML draws them, checks them, and (soon) runs
them.

Live at **[protoarch.web.app](https://protoarch.web.app)**.

```
@nodes
  Login     = page
  authLogin = api
  Home      = page
  Denied    = page

@node authLogin {
  method: POST
  path: /auth/login
  capture.token: $.data.token
  expect: 200
}

@flow
  Login -submit> authLogin
  authLogin:
    -200> Home
    -401> Denied {
      note: three strikes locks the account
    }
```

## Why

Flow diagrams rot because they live in a drawing tool, disconnected from the
thing they describe. FML is text: it diffs, it reviews, an LLM can write it, and
one file can hold the whole app. The diagram is a *view* of the source, not the
artifact.

The north star is **executable flows** — pick an API journey, hit Run, and
F\*ML fires the requests in order, threads captured values between them and
asserts the responses. The diagram becomes the test. See
[`lore/ideas/flow-execution.md`](lore/ideas/flow-execution.md).

## The language

Full reference: **[HOW-TO.md](HOW-TO.md)**.

| Section | Purpose |
|---|---|
| `@meta` | title, version, `base:` URL |
| `@vars` | default values for `{name}` interpolation |
| `@nodes` | the roster — `<id> = <type>` |
| `@node <id> { }` | metadata for one node |
| `@flow` | the arrows, inline or grouped |
| `@doc <name>` | more than one diagram in one file |
| `@fof <path>` | pull in another `.fml` file (no extension — it's always `.fml`) |

Six node types carry the meaning: `page`, `api`, `decision`, `event`, `flow`, `ui`.
Anything else draws but warns.

## Development

```bash
npm install
npm run dev        # vite dev server
npm test           # parser, stats and write-back suites
npm run demo -- examples/shop.fml   # structural read, no canvas needed
npm run build      # tsc -b && vite build
```

No backend, no database, no auth — the workspace lives in `localStorage`.
Node 22 runs the `.ts` files directly, so the tests and the demo CLI need no
build step.

### Layout

```
src/fml/        the language: parser, node-type standard, stats. Zero deps.
src/lib/        write-back text surgery, layout, React Flow mapping, styling
src/components/ canvas, sidebar, toolbar, property panel, source editor
examples/       reference .fml files — all parse clean under strict
lore/           project memory: mission, context, decisions, ideas
```

## Deploy

Firebase Hosting, project `protoarch`, serving `dist/`:

```bash
npm run build
npx firebase-tools deploy --only hosting --project protoarch
```

Every deploy is paired with a commit and push to `main`.
