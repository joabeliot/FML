# How to write FML

FML (`.fml`) is a plain-text format for flowcharts of app navigation and API calls.
You write text describing **what connects to what**; a parser turns it into
`{ nodes, edges }` and a canvas renders it as a live flowchart. Positions are
automatic — you never place boxes by hand.

This document is the complete **v0.2** syntax. An LLM agent can read this and
produce valid `.fml` for an existing app.

---

## Pipeline

```
.fml text  →  parse()  →  { meta, nodes, edges }  →  dagre auto-layout  →  canvas
```

Your job is to describe the graph. Layout, spacing, and routing are handled.

---

## File shape

A file is a list of **sections**. Each section header sits at column 0 and starts with `@`:

| Section | Purpose | Required |
|---|---|---|
| `@meta` | file-level info: `title`, `base` (the API root) | no |
| `@vars` | default values for `{name}` interpolation | no |
| `@nodes` | declare every box | yes (in practice) |
| `@node <id> { … }` | attach details to one box; repeatable | no |
| `@flow` | the arrows | yes |
| `@doc <name>` | start another flow in the same file | no |
| `@fof <path> as <name>` | pull another `.fml` file in as a flow | no |

Section **order does not matter**. Blank lines and comments are ignored. (Section
order is free *within* a doc; `@doc` / `@fof` split the file into docs — see
[`@doc`](#doc-name--more-than-one-flow-in-a-file) and [`@fof`](#fof-path-as-name--split-flows-across-files).)

### Comments

```
# whole-line comment
LoginScreen = page   # also a comment (after whitespace)
```

`#` starts a comment at the start of a line or after a space/tab.

---

## `@meta` — file-level info

```
@meta
  title: MyApp — Auth + Cart
  base: https://api.example.com
```

- `key: value`, indented, one per line — same shape as a `@node` body.
- **`title:`** names the file (shown in the viewer).
- **`base:`** is the API root every `api` node's `path:` hangs off, by
  default. With `base: https://api.example.com` and a node's
  `path: /auth/login`, the executable form of that call is
  `https://api.example.com/auth/login`. A node that carries a full `url:`
  instead ignores `base` entirely. A single node can also override it with
  its own `base:` key — see "Multiple hosts in one file" below.
- Any other key is allowed and carried through untouched; nothing else is
  interpreted today.
- With multiple `@doc`s, each doc has its own `@meta`.

---

## `@vars` — variable defaults

```
@vars
  email: demo@example.com
```

- `key: value`, indented, one per line — same shape as `@meta`.
- Gives `{name}` (see below) a default so the file runs standalone, no setup.
- **Don't put secrets here.** A variable referenced but never declared in
  `@vars` — and never `capture`d by an earlier node either — is a run-time
  input: nothing resolves it today, and once the runner exists it'll be
  prompted for instead of read from the file. That's the point — a password
  or token should never sit in something you'd commit.
- With multiple `@doc`s, each doc has its own `@vars`.

---

## `@nodes` — declare the boxes

```
@nodes
  Splash       = page
  LoginScreen  = page
  authLogin    = api
  Home         = page
```

- Syntax: `<id> = <type>`, one per line, indented.
- **id** — letters, digits, underscore only: `[A-Za-z0-9_]`.
  - OK: `LoginScreen`, `auth_login`, `v2Checkout`
  - Rejected: `login-screen` (dash), `/auth/login` (slash), `Login Screen` (space), `cart.v2` (dot)
- **type** — one of the five standard types below.
- Every box referenced in `@flow` must be declared here, or the parser errors.

### The five node types

The type is what makes a diagram mean something rather than just look like
something. Pick from this vocabulary:

| type | what it is | colour | glyph |
|---|---|---|---|
| `page` | a screen the user lands on | blue | a window |
| `api` | an HTTP request the app makes | green | two arrows |
| `decision` | a branch — the outgoing arrows are the answers | amber | a fork |
| `event` | something that happens *to* the app: cold start, push, deep link, webhook | pink | a burst |
| `flow` | a portal standing for another doc (`@doc` / `@fof`) | violet | a doorway |

Each type has keys it is expected to carry, and keys that are merely useful:

| type | expected | also understood |
|---|---|---|
| `page` | — | `route`, `title`, `image`, `note` |
| `api` | `method`, `path` (or `url`) | `body`, `auth`, `expect`, `header.<Name>`, `query.<name>`, `capture.<var>`, `note` |
| `decision` | — | `condition`, `note` |
| `event` | — | `source`, `payload`, `note` |
| `flow` | `doc` | `note` |

Only the keys in **expected** are checked, because only those stop the node from
doing its job: an `api` that names no request can't be sent, a `flow` portal
that names no doc leads nowhere. A bare `Login = page` is a complete, correct
node — sketching stays cheap.

**A type outside this list still parses and still draws** (grey, dashed accent,
tagged with whatever you wrote). It warns in loose mode and errors in `strict`.
The vocabulary is a standard, not a cage — but if you find yourself inventing
one, check first whether `decision` or `event` already covers it.

**`unknown`** is not a type you write. It is what the parser gives a node that
`@flow` referenced but `@nodes` never declared, and it renders with a dashed
border so the gap is visible.

---

## `@node <id> { … }` — box details

```
@node authLogin {
  method: POST
  path: /api/v2/auth/login
  auth: none
}
```

- The header must be `@node <id> {` — the `{` is on the **same line**.
- Body: `key: value`, indented, one per line.
- **Everything after the first `:` is the value.** Colons, slashes, query strings, JSON all pass through unquoted:
  `path: https://api.example.com/v2/cart?expand=items`
- Close with `}` alone on a line.
- **Repeatable** — a second `@node authLogin { … }` merges in more keys.
- The `id` must also appear in `@nodes`.

### Any key is allowed — including `note:` and `label:`

The body is free-form. **Every key you write is rendered on the box**, in order —
nothing is limited to `method` / `path` / `auth`.

- **`note:`** — a sentence of rationale or context for this box. Renders as its
  own row. Use it to record *why* something is the way it is.
- **`label:`** — **overrides the displayed name.** The box shows this text
  instead of the raw id, and `label` is not repeated in the metadata list. Keep
  the id terse and code-like; put the human name here.

```
@node syncPlaid {
  label: Sync Plaid
  method: POST
  path: /api/v2/plaid/sync
  note: 10s flat poll, no backoff — tiered backoff was rejected as needless complexity
}
```

> The same `{ … }` block works on a **flow arrow** too, when the rationale
> belongs to the transition rather than to either box — see
> [Edge notes](#edge-notes) under `@flow`.

### `api` keys are execution-ready — and they execute

FML's north star is *running* a flow as an API test (see
`lore/ideas/flow-execution.md`). The engine is real now: these keys are what it
sends. See [Running a flow](#running-a-flow) below.

```
@meta
  base: https://api.example.com

@node authLogin {
  method: POST
  path: /auth/login
  body: {"email": "{email}", "password": "{password}"}
  capture.token: $.data.token
  expect: 200
}

@node getCart {
  method: GET
  path: /cart
  header.Authorization: Bearer {token}
  query.expand: items
  expect: 200
}
```

- `path` resolves against `@meta base:` — or the node's own `base:`, see
  below; `url` is a full URL instead and ignores both.
- `header.<Name>`, `query.<name>` and `capture.<var>` are **dotted keys** — the
  suffix is the header/param/variable name, so each can appear any number of
  times in one block.
- `{name}` is a **variable reference**. `capture.token: $.data.token` pulls a
  value out of one response so a later node can spend it as `{token}`.
- `auth:` is sugar over the Authorization header — `none` sends nothing,
  `bearer {token}` sends `Bearer <value>`, anything else is sent literally.
- `expect:` is the status assertion — `200`, `200,201`, `2xx`, or `200-204`.

`{name}` is also resolved *statically*: click a node and its **About** tab lists
every variable it references and where the value comes from. See below.

### Multiple hosts in one file

A real app is rarely behind one origin — auth on `auth.example.com`, the API
proper on `api.example.com`. Put a `base:` key **on the node itself** and it
overrides `@meta base:` for that one call only; every other node still
resolves against the doc-level `base`, or its own override if it has one:

```
@meta
  base: https://api.example.com

@node sendOtp {
  base: https://auth.example.com
  method: POST
  path: /identity/send_verification_code/
  body: {"phone": "{phone}"}
  expect: 200
}

@node verifyOtp {
  base: https://auth.example.com
  method: POST
  path: /identity/v2/verify_egive_user_phone/
  body: {"phone": "{phone}", "code": "{otp}"}
  capture.access: $.access
  expect: 200
}

@node checkoutPost {
  method: POST                       # no base — falls back to @meta base
  path: /api/v1/billing/checkout/
  auth: bearer {access}              # token captured on the other host, spent here
  expect: 201
}
```

- `capture`, `expect`, and `auth` all work exactly the same regardless of
  which base won — the override only changes where the request goes.
- `--dry` (and every run's step log) prints the fully-resolved `method url`
  per node, so which base a node actually used is always visible — including
  on a failure, which is usually a host mismatch, not a broken request. See
  `examples/multi-host.fml`.

### Running a flow

```bash
node scripts/run.ts examples/run.fml           # send it
node scripts/run.ts examples/run.fml --dry     # print the requests, send nothing
```

The engine (`src/fml/run.ts`) walks the graph from the node nothing points at,
sends every `api` node it reaches, folds each `capture` into a single run-wide
variable store, and asserts `expect`. Exit code is 0 on pass, 1 on fail — it
works as a CI check as-is.

**Which edge it follows.** After an `api` node, the response status picks the
branch: that is exactly what `-200>` / `-404>` mean — a `decision` node's own
`condition:` is *not* one of the things that picks a branch; nothing evaluates
it yet, so a `decision` node needs exactly one way forward today (see
`examples/branching.fml`). Otherwise a lone outgoing edge is taken whatever its
label.

If the run can't tell which edge to take, it **stops and says so** rather than
guessing a path and reporting a green test that never touched the branch you
cared about — two different reasons for that:
- **unmodelled** — the node branches on status, the response just didn't match
  any of the edges drawn (a live 403 with only `-200>`/`-404>` drawn). The
  message names the missing status: draw `-403>` and the run carries on.
- **ambiguous** — several edges leave a node and none of them are status
  labels at all, so there's no way to pick.

**Capture paths** read from the response:

| path | reads |
|---|---|
| `$.data.token` | into the JSON body (the leading `$.` is optional) |
| `$.items[0].id` | array index |
| `$` | the whole body, verbatim |
| `status` | the status code |
| `header.<Name>` | a response header, case-insensitive |

A capture that finds nothing **fails the step** — a silently-empty `{token}`
is the worst outcome a test run can have.

**Supplying run-time inputs.** A `{name}` with no `@vars` default and no
`capture` is an input you pass in — that's the point of leaving secrets out of
the file:

```bash
FML_VAR_password=… node scripts/run.ts login.fml     # preferred
node scripts/run.ts login.fml --var password=…       # lands in shell history
```

The run refuses to start if any are missing, and refuses to *send* a request
that still contains an unresolved `{name}` — a literal `{token}` in a header is
a bug, not a request.

**A failed step doesn't stop the walk.** If a status has a drawn edge, you
modelled it deliberately — `-404>` exists to be walked — so the run follows it
and you see where the sad path goes, while the step and the whole run still
score red. `--fail-fast` stops at the first failure instead. A request that
never went out (missing variable, dead host) always stops the walk: there's no
status to route on.

**Flags:** `--doc <name>` picks a doc, `--start <nodeId>` starts elsewhere,
`--fail-fast` stops at the first failed step, `--json` dumps the whole run.

### Checking a file before you run it

`node scripts/demo.ts <file.fml>` now ends with a **checks** section — the
mistakes that only bite once you actually run something:

- a key outside the type's standard (`heder.Accept` silently never sends)
- `path` with no `base` (on the node or `@meta`) to resolve against
- a method that isn't an HTTP verb, an `expect` that isn't a status pattern
- `capture.x:` with no path — it would never capture anything
- `{name}`s that are run-time inputs (shown with `--all`)

Note what is deliberately *not* flagged: `expect: 200` on a node that also
draws `-404>`. That pairing is the idiom, not a contradiction.

### Running a flow from the app

The canvas has a **▶ Run** button (only enabled when the active doc has an
`api` node) — same engine as the CLI, so everything above applies unchanged.
Watch mode moves the camera node → edge → node as the run actually happens,
the step badge doubles as pass/fail on the card, and a bottom bar lists every
step with timing and the live variable store. A node's **Run** tab in the
property panel (only present once it's actually been run) shows the exact
request, response, and captures for that node. `FAST` turns the camera-follow
pacing off — the run itself is always full-speed regardless.

Same CORS boundary as any browser client: dev (`npm run dev`) routes through a
local proxy so any API works; the deployed site calls `fetch` directly and can
only reach APIs that send `Access-Control-Allow-Origin` for it. The CLI has
neither restriction — it's plain Node.

### Variables — `{name}`

A `{name}` anywhere in a node's data — `path`, `body`, a `header.*`, anything —
is a reference, resolved one of two ways:

- **`@vars` declares a default.** `email: demo@example.com` in `@vars` means
  every `{email}` resolves to that string, right now, no run required.
- **An earlier node's `capture.<name>` produces it.** `capture.token:
  $.data.token` on `authLogin` means `{token}` resolves to "captured by
  authLogin" — the actual value only exists once that request has really run.

A `{name}` that's neither declared nor captured is a **run-time input**. That's
deliberate for secrets: `{password}` with no `@vars` entry stays unset, so
nothing sensitive sits in a file you'd commit — you supply it when you run
(`FML_VAR_password=…`, see [Running a flow](#running-a-flow)).

Variable scope is **per-doc** today — a `capture` in one `@doc`/`@fof` file
doesn't resolve a `{name}` used in another, even across a `flow` portal that's
obviously the same journey continuing. That's a real gap, not yet decided: does
one *run* span multiple docs through their portals, carrying captured values
across? Undecided — flagged in `lore/ideas/flow-execution.md`.

---

## `@flow` — the arrows

Every arrow means **source → target** (arrowhead at the target).
Two equivalent ways to write one:

### Inline

```
@flow
  LoginScreen -tap login> authLogin
  authLogin -200> Home
  authLogin -401> LoginScreen
```

Form: `<source> -<label>> <target>`

### Grouped — one source, many arrows

```
@flow
  authLogin:
    -200> Home
    -401> LoginScreen
    -500> ErrorScreen
```

Write `<source>:` then indent each `-<label>> <target>` line **deeper than** the
`:` line. Each branch line is an arrow from that source. Use this for
success/failure/empty branches off an API call.

### Labels

- The label is the text between `-` and `>`. Spaces allowed: `-tap continue>`.
- `>` cannot appear inside a label.
- `->` or `-->` means **no label**.
- `-200,202>` is **one** arrow labelled `200,202` (not two arrows).
- Use labels for the **trigger** (`tap login`, `onResume`, `deeplink`) or the
  **response** (`200`, `401`, `timeout`, `error`).

### API round-trips need two arrows

```
  ProfileScreen -open> getProfile
  getProfile -200> ProfileScreen
```

### Edge notes

An arrow can carry its own `{ … }` block — **same rules as a `@node` body** —
for context that belongs to *that transition*, not to either box:

```
@flow
  authLogin -401> LoginScreen {
    note: token expired mid-flow, not a fresh 401
  }
```

Works on grouped arrows too:

```
@flow
  authLogin:
    -200> Home
    -500> ErrorScreen {
      note: only fires on a cold DB, see incident 114
    }
```

- The opening `{` is on the **same line as the arrow** (like `@node x {`). It
  cannot go on its own line.
- Close with `}` alone on a line. Body is `key: value`, indented deeper than the
  arrow. `note:` is only a convention — any key works, same as `@node`.
- **No `#` inside a note value.** `#` after a space starts a comment and the rest
  of the line is dropped — write `incident 114`, not `incident #114`.
- Edge notes are parsed into `edges[].data` and are **editable in the property
  panel** (click the arrow). They also show in `demo.ts --json`. The note text is
  not yet painted on the edge line itself.

---

## `@doc <name>` — more than one flow in a file

A real app is several journeys. Give each its own `@doc`:

```
@doc main

@nodes
  Home     = page
  Checkout = flow

@node Checkout { doc: checkout }

@flow
  Home -cart> Checkout

@doc checkout

@nodes
  Cart    = page
  payApi  = api
  Receipt = page

@flow
  Cart -pay> payApi
  payApi -201> Receipt
```

- `@doc <name>` at column 0 starts a doc. `<name>` is `[A-Za-z0-9_]`.
- Everything before the first `@doc` — or the whole file, if there is no `@doc` —
  is one doc called **`main`**.
- Each doc is a **separate graph**: its own `@meta`, `@nodes`, `@flow`. **Node ids
  are doc-local** — `Cart` in one doc and `Cart` in another are two different
  boxes.
- **Arrows cannot cross docs.** `@flow` inside the `checkout` doc can only wire
  `checkout`'s own nodes. To connect one journey to another, use a portal ↓.

### Portals — a `flow` node standing for another doc

A `flow` node stands in for a whole doc. Its `doc:` key names the target:

```
@nodes
  Checkout = flow
@node Checkout {
  doc: checkout      # matches a @doc name (or an @fof name — see below)
}
@flow
  Home -cart> Checkout
```

In the viewer, **double-click the portal** to open the doc it points at. If
`doc:` names nothing that exists, the portal warns.

---

## `@fof <path> as <name>` — split flows across files

`@fof` ("flow of file") pulls another `.fml` file in as one more doc — one file
per journey, assembled at the top of the entry file:

```
# app.fml — the entry file
@fof ./auth as auth
@fof ./checkout as checkout

@nodes
  Home     = page
  Auth     = flow
  Checkout = flow

@node Auth      { doc: auth }
@node Checkout  { doc: checkout }

@flow
  Home -sign in> Auth
  Home -cart> Checkout
```

- `@fof <path> as <name>` sits at column 0, before the `@nodes` that use it.
- **The path has no extension** — it is always `.fml`. `./auth` loads `auth.fml`
  from the same folder as the file doing the importing.
- **`as <name>` is required.** That name is what a `flow` node's `doc:` points at,
  and what the imported file's flow is called.
- `@fof` **nests** — an imported file may `@fof` further files. A circular import
  is caught and reported, not followed.
- If the imported file has several `@doc`s, the first becomes `<name>` and the
  rest come along under their own names.
- In the viewer, drop the whole set of files in at once (multi-select the files,
  or drag them in together) and every `@fof` resolves.

---

## Modelling an app

| App concept | FML |
|---|---|
| Activity / Fragment / screen / Composable | `page` node |
| REST endpoint | `api` node + `method` / `path` in a `@node { }` block |
| User navigates screen → screen | `page -action> page` |
| Screen calls an endpoint | `page -trigger> api` |
| Endpoint response routes somewhere | `api -status> page` |
| Success / failure / empty branch | multiple labelled arrows from the `api` node |
| Deep link / push / cold start / webhook | an `event` node, with `source:` naming the trigger |
| Client-side branch (has-token? role check?) | a `decision` node — **draws** the branch, but if the flow needs to actually *run* past it, the fork has to happen one `api` node earlier, on that call's status (see `examples/branching.fml`); a `decision` node itself takes exactly one arrow forward today |
| A sub-journey that deserves its own diagram | a `flow` node with `doc:`, plus the `@doc` / `@fof` it points at |
| Why a box / branch exists | `note:` in that node's `@node { }` block |
| Why a *transition* is the way it is | a `{ note: … }` block on the arrow |

**Naming convention**

- Screens: PascalCase — `LoginScreen`, `CartScreen`, `OrderDetail`
- Endpoints: camelCase describing the call — `authLogin`, `getCart`, `postCheckout`
- Keep the HTTP path in the `@node` block, **not** in the id.

---

## Full example

```
@meta
  title: MyApp — Auth + Cart

@nodes
  Splash        = page
  LoginScreen   = page
  Home          = page
  CartScreen    = page
  ErrorScreen   = page
  authLogin     = api
  getCart       = api
  postCheckout  = api

@node authLogin {
  method: POST
  path: /api/v2/auth/login
}
@node getCart {
  method: GET
  path: /api/v2/cart
}
@node postCheckout {
  method: POST
  path: /api/v2/checkout
}

@flow
  Splash -token valid> Home
  Splash -no token> LoginScreen

  LoginScreen -tap login> authLogin
  authLogin:
    -200> Home
    -401> LoginScreen
    -500> ErrorScreen

  Home -open cart> getCart
  getCart -200> CartScreen

  CartScreen -tap checkout> postCheckout
  postCheckout:
    -200> Home
    -402> CartScreen
    -500> ErrorScreen
```

---

## Rules & gotchas

- **Declare before use.** Every id in `@flow` must be in `@nodes`.
- **ids are `[A-Za-z0-9_]` only.** A dash in an id breaks parsing — the parser
  reads `-` as the start of an arrow.
- **Indent group branch lines deeper than their `id:` line**, or they won't attach.
- **One `>` per arrow.** Never put `>` inside a label.
- **`@node` header brace on the same line:** `@node x {` ✅ — `@node x` then `{` ❌
- **Edge note brace on the same line too:** `A -x> B {` ✅ — the `{` cannot sit
  on its own line; close the block with `}` alone on a line.
- Reusing a node id across many arrows is fine — it's the same box.
- **Off-standard node types are not errors in loose mode.** Anything outside
  `page` / `api` / `decision` / `event` / `flow` renders grey and warns; under
  `strict` it errors. Only an unknown `@directive` always errors.
- **Unknown `@node` keys are not parse errors.** Every key renders on the box
  regardless. `node scripts/demo.ts` *does* flag one on a standard type as a
  warning, though — that's the typo catcher (`heder.Accept` never sending is
  a worse surprise than a warning).
- **Key charset is `[A-Za-z0-9_.-]`.** The `.` is what makes `header.Accept`,
  `query.page` and `capture.token` work.
- **Blank lines are ignored today.** Use them to visually group related flows;
  a future version will treat a blank line as a boundary between separate
  diagrams, so organising with them now is future-proof.

---

## What errors mean

`parse()` returns `{ ok, errors, warnings }`, each issue carrying a `line` and
`message`. If `ok` is `false`, fix the listed lines. Common messages:

| Message | Fix |
|---|---|
| `flow references undeclared node "X"` | add `X` to `@nodes` |
| `expected "<id> = <type>"` | malformed `@nodes` line |
| `@node X block is missing a closing "}"` | add the `}` |
| `unrecognised flow line: "…"` | the line isn't a valid arrow or `id:` header |
| `edge note block for "X -> Y" is missing a closing "}"` | add the `}` for that edge's `{ … }` block |
| `unknown directive: "@…"` | only `@meta`, `@vars`, `@nodes`, `@node`, `@flow`, `@doc`, `@fof` are valid |
| `unknown node type "X" for "Y"` | use one of the five standard types, or accept the warning |
| `api "X" is missing "method", "path"` | strict-mode hint — add the keys, or turn strict off while sketching |
| `@doc needs a name matching [A-Za-z0-9_]` | `@doc My Flow` → `@doc myFlow` |
| `@doc "X" repeated — merging` | two `@doc X` headers — rename one |
| `@fof needs "@fof <path> [as <name>]"` | malformed `@fof` line |
| `@fof "X" — add "as <name>"` | `@fof ./auth` → `@fof ./auth as auth` |
| `cannot resolve @fof "X"` | that file isn't in the workspace / folder |
| `circular @fof "X"` | two files `@fof` each other — break the loop |

---

## Testing a `.fml` file

### CLI — `node scripts/demo.ts path/to/file.fml`

The check to run when you **can't see the rendered canvas**. It prints `ok`,
every error/warning with a line number, then a full structural read of the graph:

```
=== examples/app.fml ===
ok: true

  flows:        3
    1. 4 nodes · 3 edges · entry: Login
    2. 3 nodes · 2 edges · entry: Cart
    3. 2 nodes · 2 edges · entry: (none — cyclic)
  nodes:        9   (7 page · 2 api)
  edges:        7
  entry points: 2   (Cart, Login)
  terminals:    3   (Denied, Home, Receipt)
```

| Line | Means | Catches |
|---|---|---|
| `flows: N` | N disconnected sub-graphs | a node you meant to wire that landed off on its own |
| `entry: (none — cyclic)` | that flow has no in-degree-0 node | a loop with no way in |
| `entry points` | every node nothing points at | a screen that should be reachable but isn't |
| `terminals` | every node that points nowhere | a dead end you didn't intend |
| `unwired` *(shown only if any)* | declared in `@nodes`, used in no arrow | a mistyped id, or a box you forgot to connect |

Add `--json` to also dump the parsed `{ meta, nodes, edges }`.

### Viewer

`npm run dev`, open `http://localhost:5173`, click **Open .fml** (or paste into
the **Source** panel to edit live and watch it re-render). Drag-and-drop works
too, and multi-select pulls in a whole `@fof` set at once.

What the viewer gives you beyond the picture:

- **Click a node or an arrow** → the right-hand property panel. Editing there
  writes straight back into the `.fml` source, into the right file when the doc
  came in through `@fof`. Comments and layout survive the edit.
- The panel knows the standard: it lists the type's expected keys as one-click
  chips and explains what the type means.
- **Double-click a `flow` node** to drill into the doc its `doc:` key names.
- **Click a step badge** (top-right of a card) to spotlight that node's
  immediate `prev` / `next` neighbours and dim the rest.
- A node's **Code** tab shows its literal FML — the `@nodes` line plus its
  `@node { }` block — editable, with copy / apply / revert.
- A node's **About** tab lists every `{name}` it references and how it
  resolves — an `@vars` default, "captured by `<node>`", or "not set, asked
  for when run".
- **Drag a node** to hand-place it. The position is saved outside the `.fml`
  (never written into the file — layout stays automatic) and survives
  switching docs and back; auto-layout still runs for everything you haven't
  dragged.
- **Walkthrough** (bottom-right) lists the flow as plain steps; **the error /
  warning count** in the toolbar opens the issue list. Both collapse.
- **Esc** clears the selection, **⌘\\** hides the sidebar, **Save** downloads
  the entry file. The viewer always parses in loose mode (warnings, never
  blocked); pass `{ strict: true }` to `parse()` for the
  strict pass.

---

## Checklist before handing off a `.fml`

- [ ] Every screen and endpoint is declared in `@nodes`
- [ ] Types are `page` / `api`, or a deliberate custom type (`decision`, …)
- [ ] All ids match `[A-Za-z0-9_]` (no dashes, dots, slashes, spaces)
- [ ] Every id used in `@flow` exists in `@nodes`
- [ ] Endpoint `method` + `path` live in `@node { }` blocks, not the id
- [ ] Group branch lines are indented deeper than their `id:` line
- [ ] Each arrow has exactly one `>`
- [ ] Every edge `{ … }` note block opens on the arrow line and closes with `}`
- [ ] No `#` inside a `note:` value (it starts a comment)
- [ ] Every `flow` node has a `doc:` matching a `@doc` or `@fof` name
- [ ] No arrow crosses between `@doc`s — a `flow` portal does that instead
- [ ] Every `@fof` line has `as <name>` and a path with no extension
- [ ] Every `{name}` either has an `@vars` default, is `capture`d by an earlier
      node in the *same* doc, or is meant to stay unset (a secret)
- [ ] Every `decision` node has exactly one way forward — its `condition:` is
      documentation, not something the runner evaluates yet
- [ ] `node scripts/demo.ts <file>` parses clean and lints clean (the
      **checks** section is empty, or every remaining line is `info`)
- [ ] If it has `api` nodes: `node scripts/run.ts <file> --dry` shows the
      request(s) you expect, then `node scripts/run.ts <file>` actually passes
