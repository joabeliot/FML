// FML — the execution engine.
//
// Turns a drawn flow into a run: send each `api` node's request, pull values
// out of the response into variables, assert the status, follow the edge that
// matches. The diagram *is* the test.
//
// Two rules keep this file honest:
//
//   1. Zero dependencies, like the rest of `src/fml/`. It has to run in Node
//      (tests, CI, `npm run demo`) and in the browser, unchanged.
//   2. **No network in here.** The caller passes a `Transport` — anything that
//      takes a request and returns a response. In tests that's a fake with
//      canned answers; in the browser it's `fetch`; when the CORS story lands
//      it becomes a proxy call. Swapping transports must never touch this
//      logic, so the engine can be finished and tested before that decision.
//
// See lore/ideas/flow-execution.md for the key vocabulary this implements.
//
// `ui` nodes (FML-19) follow the same rule with a browser instead of the
// network: the caller passes a `UiDriver`, this file never imports one. No
// driver (the in-app runner) means `ui` steps are skipped, not failed.

import { callEnd, evaluateAssertion, parseAssertion } from "./assert.ts";
import type { FmlDoc, FmlEdge, FmlNode } from "./types.ts";

// -- transport ------------------------------------------------------------

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Absent for a request with no body (GET/DELETE, or an unset `body` key). */
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Raw text. `capture` parses it as JSON on demand — a non-JSON body is fine. */
  body: string;
  /**
   * The body exactly as it came off the wire. Text decoding is lossy for
   * binary media, so `body.sha256` / `body.bytes` read this when a transport
   * supplies it, and fall back to the UTF-8 encoding of `body` when not.
   */
  bytes?: Uint8Array<ArrayBuffer>;
}

export type Transport = (req: HttpRequest, signal?: AbortSignal) => Promise<HttpResponse>;

// -- UI driver (FML-19) -----------------------------------------------------

export type UiActionKind = "open" | "fill" | "click" | "press" | "wait";

/** One thing to do on the page. `target` is a URL for `open`, a selector otherwise. */
export interface UiAction {
  kind: UiActionKind;
  target: string;
  /** The text for `fill`, the key for `press`. */
  value?: string;
}

/**
 * What a `ui` node needs from a browser. Injected exactly like `Transport` —
 * the CLI hands in a Playwright-backed one (scripts/uiDriver.ts), tests hand
 * in a fake, and the browser app has none.
 */
export interface UiDriver {
  perform(action: UiAction, signal?: AbortSignal): Promise<void>;
  /**
   * Read a value off the page for `capture` / `assert`: `url`, `title`, or a
   * page read — `text(sel)`, `count(sel)`, `value(sel)`, `visible(sel)`,
   * `attr(sel, name)`. Undefined when it leads nowhere.
   */
  read(path: string): Promise<string | undefined>;
  /** Save a screenshot under this name and return where it went. */
  screenshot(name: string): Promise<string>;
}

// -- interpolation --------------------------------------------------------

const VAR_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface Interpolated {
  text: string;
  /** Names referenced but absent from the store — a run-time input nobody supplied. */
  missing: string[];
}

/**
 * Substitute every `{name}` from the live variable store. Unknown names are
 * left verbatim *and* reported: a request that would go out with a literal
 * `{token}` in the header is a bug, not a request, so callers refuse to send
 * it rather than letting the API reject a nonsense value.
 */
export function interpolate(value: string, vars: Record<string, string>): Interpolated {
  const missing: string[] = [];
  const text = value.replace(VAR_RE, (whole, name: string) => {
    const hit = vars[name];
    if (hit === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return hit;
  });
  return { text, missing };
}

// -- reading values out of a response -------------------------------------

/** Split `$.data.items[0].id` into ["data","items","0","id"]. */
function pathTokens(path: string): string[] {
  const out: string[] = [];
  for (const m of path.matchAll(/[^.[\]]+/g)) {
    if (m[0] !== "$") out.push(m[0]);
  }
  return out;
}

function asText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Resolve one `capture.<var>` expression against a response.
 *
 *   `$.data.token`   into the JSON body (leading `$.` optional)
 *   `$`              the whole body, verbatim
 *   `status`         the status code
 *   `header.<Name>`  a response header, case-insensitive
 *   `body.bytes`     the body's length in bytes (raw, not characters)
 *   `….length`       as the last segment on an array, its length — so
 *                    `assert.sources.length: >= 2` works. Only there: on an
 *                    object, `length` is still just a key.
 *
 * Returns undefined when the path doesn't lead anywhere — the caller reports
 * that as a failed capture rather than storing an empty string, because a
 * silently-empty `{token}` is the worst possible outcome of a test run.
 */
export function readPath(res: HttpResponse, path: string): string | undefined {
  const expr = path.trim();
  if (expr === "status") return String(res.status);
  if (expr === "$" || expr === "") return res.body;

  if (expr === "body.bytes") return String(rawBytes(res).length);

  const lower = expr.toLowerCase();
  if (lower.startsWith("header.")) {
    const want = expr.slice("header.".length).toLowerCase();
    for (const [k, v] of Object.entries(res.headers)) {
      if (k.toLowerCase() === want) return v;
    }
    return undefined;
  }

  let cursor: unknown;
  try {
    cursor = JSON.parse(res.body);
  } catch {
    return undefined;
  }

  const tokens = pathTokens(expr);
  for (const [at, token] of tokens.entries()) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      if (token === "length" && at === tokens.length - 1) return String(cursor.length);
      const i = Number(token);
      if (!Number.isInteger(i)) return undefined;
      cursor = cursor[i < 0 ? cursor.length + i : i];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[token];
  }
  return asText(cursor);
}

/** The body as bytes — the transport's own when it kept them. */
function rawBytes(res: HttpResponse): Uint8Array<ArrayBuffer> {
  return res.bytes ?? new TextEncoder().encode(res.body);
}

/**
 * `readPath`, plus the one path that can't be synchronous: `body.sha256`, the
 * lowercase hex SHA-256 of the raw body. Web Crypto is built into Node and
 * every browser, so this stays dependency-free.
 */
export async function resolvePath(res: HttpResponse, path: string): Promise<string | undefined> {
  if (path.trim() !== "body.sha256") return readPath(res, path);
  const digest = await crypto.subtle.digest("SHA-256", rawBytes(res));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// -- status assertions ----------------------------------------------------

/**
 * Does a status satisfy an `expect` / edge label? A comma-separated list of
 * exact codes (`200`), wildcard classes (`2xx`) or ranges (`200-204`); any one
 * matching is a match.
 */
export function statusMatches(pattern: string, status: number): boolean {
  for (const raw of pattern.split(",")) {
    const part = raw.trim().toLowerCase();
    if (part === "") continue;
    if (/^\d+$/.test(part)) {
      if (Number(part) === status) return true;
      continue;
    }
    const wildcard = part.match(/^(\d)xx$/);
    if (wildcard) {
      if (Math.floor(status / 100) === Number(wildcard[1])) return true;
      continue;
    }
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range && status >= Number(range[1]) && status <= Number(range[2])) return true;
  }
  return false;
}

/** True when a label could be a status assertion at all (`200`, `2xx`, `200,201`). */
export function isStatusLabel(label: string): boolean {
  const parts = label.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return false;
  return parts.every((p) => /^\d+$/.test(p) || /^\dxx$/i.test(p) || /^\d+-\d+$/.test(p));
}

// -- building one request -------------------------------------------------

export interface BuiltRequest {
  request?: HttpRequest;
  /** Variables the node references that nothing has supplied yet. */
  missing: string[];
  /** Why no request could be built at all (never set alongside `request`). */
  error?: string;
}

function joinUrl(base: string, path: string): string {
  if (path === "") return base;
  if (base === "") return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function appendQuery(url: string, query: Array<[string, string]>): string {
  if (query.length === 0) return url;
  const qs = query
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return url + (url.includes("?") ? "&" : "?") + qs;
}

/**
 * Assemble the HTTP request an `api` node describes, with every `{name}`
 * already substituted.
 *
 * `url` wins over `path`; `path` is joined onto a base — the node's own
 * `base` when it has one (a flow that spans services, e.g. auth on one host,
 * billing on another), otherwise the doc's `@meta base`. `header.<Name>` and
 * `query.<name>` are repeatable. `auth` is sugar over the Authorization
 * header: `none` sends nothing, `bearer <v>` sends `Bearer <v>`, anything
 * else is passed through literally.
 */
export function buildRequest(
  node: FmlNode,
  meta: Record<string, string>,
  vars: Record<string, string>,
): BuiltRequest {
  const missing: string[] = [];
  const sub = (value: string): string => {
    const { text, missing: gaps } = interpolate(value, vars);
    for (const name of gaps) if (!missing.includes(name)) missing.push(name);
    return text;
  };

  const data = node.data;
  const method = (data.method ?? "GET").trim().toUpperCase();

  const explicit = data.url?.trim();
  const path = data.path?.trim();
  if (!explicit && !path) {
    return { missing, error: `${node.id}: needs a "url" or a "path" to send anything` };
  }
  const nodeBase = data.base?.trim();
  const base = sub((nodeBase || meta.base || "").trim());
  let url = explicit ? sub(explicit) : joinUrl(base, sub(path ?? ""));
  if (!explicit && base === "" && !url.startsWith("http")) {
    return {
      missing,
      error: `${node.id}: "path" is relative but there's no "base" on the node or "@meta base" on the doc`,
    };
  }

  const headers: Record<string, string> = {};
  const query: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("header.")) headers[key.slice("header.".length)] = sub(value);
    else if (key.startsWith("query.")) query.push([key.slice("query.".length), sub(value)]);
  }
  url = appendQuery(url, query);

  const auth = data.auth?.trim();
  if (auth && auth.toLowerCase() !== "none") {
    const resolved = sub(auth);
    const bearer = resolved.match(/^bearer\s+(.+)$/i);
    headers.Authorization = bearer ? `Bearer ${bearer[1]!.trim()}` : resolved;
  }

  const rawBody = data.body?.trim();
  const body = rawBody ? sub(rawBody) : undefined;
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    if (body.startsWith("{") || body.startsWith("[")) headers["Content-Type"] = "application/json";
  }

  return { request: { method, url, headers, ...(body === undefined ? {} : { body }) }, missing };
}

// -- running one node -----------------------------------------------------

export interface CaptureResult {
  name: string;
  path: string;
  value?: string;
  ok: boolean;
}

export interface AssertResult {
  /** The key suffix, `assert.<label>`. */
  label: string;
  /** The path actually read — the suffix, or a `$…` the value named. */
  path: string;
  /** The comparison as written, after the colon. */
  expr: string;
  /** What the path resolved to; absent when it led nowhere. */
  actual?: string;
  ok: boolean;
  /** Why it failed — malformed expression, nothing at the path, or a mismatch. */
  message?: string;
}

export interface StepResult {
  nodeId: string;
  type: string;
  /** No request was sent — a `page`/`decision`/`event`/`flow` node just routes. */
  passthrough: boolean;
  /** A `ui` step that didn't run, and why (no driver — the in-app runner). Still `ok`. */
  skipped?: string;
  /** Questions put to a person before this step acted (FML-26) — never their answers. */
  asked?: AskRecord[];
  /** What a `ui` step did, in order, and where its screenshot went. */
  ui?: { actions: string[]; screenshot?: string };
  request?: HttpRequest;
  response?: HttpResponse;
  captures: CaptureResult[];
  /** Every `assert.<path>` on the node, evaluated after captures and `expect`. */
  asserts: AssertResult[];
  /** The node's `expect` pattern, when it declared one. */
  expect?: string;
  ok: boolean;
  error?: string;
  /**
   * Which check `error` is about, when the step failed — the first one in
   * runNode's precedence: no response at all, then status, capture, assert.
   */
  failedOn?: "request" | "status" | "capture" | "assert" | "ui" | "ask";
  durationMs?: number;
}

/** Every `capture.<name>` on a node, in declaration order. */
function captureKeys(node: FmlNode): Array<[string, string]> {
  return Object.entries(node.data)
    .filter(([k]) => k.startsWith("capture."))
    .map(([k, v]) => [k.slice("capture.".length), v]);
}

/** Every `assert.<label>` on a node, in declaration order. */
function assertKeys(node: FmlNode): Array<[string, string]> {
  return Object.entries(node.data)
    .filter(([k]) => k.startsWith("assert."))
    .map(([k, v]) => [k.slice("assert.".length), v]);
}

/**
 * Score a response against the node's `assert.*` keys. Runs after captures,
 * so an operand can name a `{value}` this very node just pulled out.
 */
async function evaluateAsserts(
  node: FmlNode,
  read: (path: string) => Promise<string | undefined>,
  vars: Record<string, string>,
): Promise<AssertResult[]> {
  const out: AssertResult[] = [];
  for (const [label, value] of assertKeys(node)) {
    const expr = value.trim();
    const parsed = parseAssertion(label, value);
    if (!parsed.ok) {
      out.push({ label, path: label, expr, ok: false, message: parsed.error });
      continue;
    }
    const a = parsed.assertion;
    const actual = await read(a.path);
    const { text: operand, missing } = interpolate(a.operand, vars);
    const outcome =
      missing.length > 0
        ? { ok: false, message: `no value for ${missing.map((n) => `{${n}}`).join(", ")}` }
        : evaluateAssertion(a, actual, operand);
    out.push({
      label,
      path: a.path,
      expr,
      ...(actual === undefined ? {} : { actual }),
      ok: outcome.ok,
      ...(outcome.message ? { message: outcome.message } : {}),
    });
  }
  return out;
}

/**
 * Send one `api` node and fold its captures into `vars` (mutated in place, so
 * the next node in the same run sees them — that threading *is* the feature).
 *
 * Captures run before the `expect` assertion, so a failing step still tells
 * you what came back instead of throwing the response away. `assert.*` keys
 * run last and score the step exactly like `expect` does — red, but the walk
 * still follows the drawn edge (`stopOnFailure` is the fail-fast override).
 */
export async function runNode(
  node: FmlNode,
  meta: Record<string, string>,
  vars: Record<string, string>,
  transport: Transport,
  signal?: AbortSignal,
  ui?: UiDriver,
): Promise<StepResult> {
  const base: StepResult = {
    nodeId: node.id,
    type: node.type,
    passthrough: false,
    captures: [],
    asserts: [],
    ok: true,
  };

  if (node.type === "ui") return runUiNode(node, meta, vars, base, ui, signal);
  if (node.type !== "api") return { ...base, passthrough: true };

  const built = buildRequest(node, meta, vars);
  if (built.error) return { ...base, ok: false, failedOn: "request", error: built.error };
  if (built.missing.length > 0) {
    return {
      ...base,
      ok: false,
      failedOn: "request",
      error: `${node.id}: no value for ${built.missing.map((n) => `{${n}}`).join(", ")} — declare it in @vars, capture it earlier, or supply it when you run`,
    };
  }

  const request = built.request!;
  const started = Date.now();
  let response: HttpResponse;
  try {
    response = await transport(request, signal);
  } catch (err) {
    return {
      ...base,
      request,
      ok: false,
      failedOn: "request",
      durationMs: Date.now() - started,
      error: `${node.id}: request failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const durationMs = Date.now() - started;

  const captures: CaptureResult[] = [];
  for (const [name, path] of captureKeys(node)) {
    const value = await resolvePath(response, path);
    captures.push({ name, path, value, ok: value !== undefined });
    if (value !== undefined) vars[name] = value;
  }

  const expect = node.data.expect?.trim();
  const statusOk = !expect || statusMatches(expect, response.status);
  const failedCapture = captures.find((c) => !c.ok);
  const asserts = await evaluateAsserts(node, (path) => resolvePath(response, path), vars);
  const failedAssert = asserts.find((a) => !a.ok);

  let error: string | undefined;
  let failedOn: StepResult["failedOn"];
  if (!statusOk) {
    error = `${node.id}: expected ${expect}, got ${response.status}`;
    failedOn = "status";
  } else if (failedCapture) {
    error = `${node.id}: capture.${failedCapture.name} found nothing at "${failedCapture.path}"`;
    failedOn = "capture";
  } else if (failedAssert) {
    error = `${node.id}: assert.${failedAssert.label} ${failedAssert.message}`;
    failedOn = "assert";
  }

  return {
    ...base,
    request,
    response,
    captures,
    asserts,
    ...(expect ? { expect } : {}),
    durationMs,
    ok: !error,
    ...(error ? { error } : {}),
    ...(failedOn ? { failedOn } : {}),
  };
}

// -- running a ui node (FML-19) --------------------------------------------

/**
 * The actions a `ui` node asks for, in the one order a node performs them:
 * open → fill.<selector> (as written) → click → press → wait. A longer
 * journey is a chain of `ui` nodes — a block's keys are a map, so one node
 * can't hold two clicks in sequence.
 */
export function uiActions(
  node: FmlNode,
  meta: Record<string, string>,
  vars: Record<string, string>,
): { actions: UiAction[]; missing: string[]; error?: string } {
  const missing: string[] = [];
  const sub = (value: string): string => {
    const { text, missing: gaps } = interpolate(value.trim(), vars);
    for (const n of gaps) if (!missing.includes(n)) missing.push(n);
    return text;
  };
  const data = node.data;
  const actions: UiAction[] = [];

  const open = data.open?.trim();
  if (open) {
    let url = sub(open);
    if (!/^[a-z]+:\/\//i.test(url)) {
      const base = sub(meta.ui_base ?? "");
      if (!base) {
        return { actions, missing, error: `${node.id}: "open: ${open}" is relative but the doc has no "@meta ui_base"` };
      }
      url = joinUrl(base, url);
    }
    actions.push({ kind: "open", target: url });
  }
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("fill.")) continue;
    // A key can't hold a CSS selector, so the suffix names a form field —
    // by name, id or test id. `sel(<css>)` at the start of the value targets
    // anything else.
    const raw = value.trim();
    const end = callEnd(raw, ["sel"]);
    const target = end !== undefined ? sub(raw.slice(4, end - 1)) : fieldSelector(key.slice("fill.".length));
    actions.push({ kind: "fill", target, value: sub(end !== undefined ? raw.slice(end).trim() : raw) });
  }
  if (data.click?.trim()) actions.push({ kind: "click", target: sub(data.click) });
  if (data.press?.trim()) {
    // `press: Enter` presses on the focused element; `press: input[name=q] Enter` on a selector.
    const raw = sub(data.press);
    const split = raw.lastIndexOf(" ");
    actions.push(
      split === -1 ? { kind: "press", target: "", value: raw } : { kind: "press", target: raw.slice(0, split), value: raw.slice(split + 1) },
    );
  }
  if (data.wait?.trim()) actions.push({ kind: "wait", target: sub(data.wait) });
  return { actions, missing };
}

/** `fill.<field>` → the field by name, id or test id, whichever the page uses. */
export function fieldSelector(field: string): string {
  const f = field.replace(/"/g, '\\"');
  return `[name="${f}"], [id="${f}"], [data-testid="${f}"]`;
}

const describe = (a: UiAction): string =>
  a.kind === "fill" ? `fill ${a.target} = ${a.value ?? ""}` : a.kind === "press" ? `press ${a.target ? `${a.target} ` : ""}${a.value ?? ""}` : `${a.kind} ${a.target}`;

async function runUiNode(
  node: FmlNode,
  meta: Record<string, string>,
  vars: Record<string, string>,
  base: StepResult,
  driver: UiDriver | undefined,
  signal?: AbortSignal,
): Promise<StepResult> {
  if (!driver) {
    return { ...base, skipped: "no browser to drive here — ui steps run from the CLI (node scripts/run.ts)" };
  }

  const plan = uiActions(node, meta, vars);
  if (plan.error) return { ...base, ok: false, failedOn: "ui", error: plan.error };
  if (plan.missing.length > 0) {
    return {
      ...base,
      ok: false,
      failedOn: "request",
      error: `${node.id}: no value for ${plan.missing.map((n) => `{${n}}`).join(", ")} — declare it in @vars, capture it earlier, or supply it when you run`,
    };
  }

  const started = Date.now();
  const done: string[] = [];
  for (const action of plan.actions) {
    try {
      await driver.perform(action, signal);
      done.push(describe(action));
    } catch (err) {
      return {
        ...base,
        ok: false,
        failedOn: "ui",
        ui: { actions: done },
        durationMs: Date.now() - started,
        error: `${node.id}: ${describe(action)} failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      };
    }
  }

  // Page reads may hold {name}s too (`text([data-id={itemId}])`).
  const read = (path: string) => driver.read(interpolate(path, vars).text);

  const captures: CaptureResult[] = [];
  for (const [name, path] of captureKeys(node)) {
    const value = await read(path.trim());
    captures.push({ name, path, value, ok: value !== undefined });
    if (value !== undefined) vars[name] = value;
  }
  const asserts = await evaluateAsserts(node, read, vars);

  let screenshot: string | undefined;
  const shot = node.data.screenshot?.trim();
  if (shot) {
    const name = shot === "true" || shot === "yes" ? node.id : interpolate(shot, vars).text;
    try {
      screenshot = await driver.screenshot(name);
    } catch {
      // A screenshot is evidence, not the test — failing to save one never fails the step.
    }
  }

  const failedCapture = captures.find((c) => !c.ok);
  const failedAssert = asserts.find((a) => !a.ok);
  let error: string | undefined;
  let failedOn: StepResult["failedOn"];
  if (failedCapture) {
    error = `${node.id}: capture.${failedCapture.name} found nothing at "${failedCapture.path}"`;
    failedOn = "capture";
  } else if (failedAssert) {
    error = `${node.id}: assert.${failedAssert.label} ${failedAssert.message}`;
    failedOn = "assert";
  }

  return {
    ...base,
    captures,
    asserts,
    ui: { actions: done, ...(screenshot ? { screenshot } : {}) },
    durationMs: Date.now() - started,
    ok: !error,
    ...(error ? { error } : {}),
    ...(failedOn ? { failedOn } : {}),
  };
}

// -- asking a person mid-run (FML-26) ---------------------------------------
//
//   ask.<name>: <prompt>   before the node acts, ask a person for <name>; the
//                          answer is {name} for this node and every later one.
//                          Already set (--var, the run dialog, .fml.env)? Not
//                          asked — that's how a CI run supplies it up front.
//   pause: <message>       before the node acts, wait until a person says go.
//
// Like Transport and UiDriver, the asking is injected (RunOptions.ask): the
// app shows a dialog, the CLI prompts on the terminal. No handler means
// nobody can answer — the step fails saying so, rather than hanging.

export interface AskRequest {
  nodeId: string;
  kind: "value" | "confirm";
  /** The variable the answer becomes, for a `value` ask. */
  name?: string;
  prompt: string;
  /** Looks like a secret (an OTP, a password…): mask it, and redact it. */
  secret: boolean;
}

/** The answer (`""` for a confirm), or `null` when the person cancels the run. May throw to fail the step. */
export type AskHandler = (req: AskRequest, signal?: AbortSignal) => Promise<string | null>;

export interface AskRecord {
  kind: "value" | "confirm";
  name?: string;
  /** How long the run waited for the person. */
  waitedMs: number;
}

const SECRETISH = /pass|secret|token|otp|code|pin|key|auth|cred/i;
export const looksSecret = (name: string): boolean => SECRETISH.test(name);

/** What a node will ask before it acts: its `pause`, then each `ask.<name>`, in order. */
export function askRequests(node: FmlNode): AskRequest[] {
  const out: AskRequest[] = [];
  const pause = node.data.pause?.trim();
  if (pause !== undefined && node.data.pause !== undefined) {
    out.push({ nodeId: node.id, kind: "confirm", prompt: pause || `Continue past ${node.id}?`, secret: false });
  }
  for (const [key, value] of Object.entries(node.data)) {
    if (!key.startsWith("ask.")) continue;
    const name = key.slice("ask.".length).trim();
    if (!name) continue;
    out.push({ nodeId: node.id, kind: "value", name, prompt: value.trim() || `Value for {${name}}`, secret: looksSecret(name) });
  }
  return out;
}

/** Ask a node's questions. `cancelled` when the person stops the run; `error` when nobody can answer. */
async function askPerson(
  node: FmlNode,
  vars: Record<string, string>,
  ask: AskHandler | undefined,
  signal?: AbortSignal,
): Promise<{ asked: AskRecord[]; cancelled?: boolean; error?: string }> {
  const asked: AskRecord[] = [];
  for (const q of askRequests(node)) {
    if (q.kind === "value" && vars[q.name!] !== undefined) continue; // supplied up front
    // A prompt can quote what the run knows so far: "Look up {username}'s posts?"
    const req = { ...q, prompt: interpolate(q.prompt, vars).text };
    if (!ask) {
      return {
        asked,
        error:
          req.kind === "value"
            ? `${node.id}: asks a person for {${req.name}} ("${req.prompt}") and nothing here can ask — supply it up front (--var ${req.name}=…) or run it interactively`
            : `${node.id}: waits for a person ("${req.prompt}") and nothing here can wait — run it interactively, or pass --yes to continue past pauses`,
      };
    }
    const started = Date.now();
    let answer: string | null;
    try {
      answer = await ask(req, signal);
    } catch (err) {
      if (signal?.aborted) throw err; // stopped while waiting: an abort, like a request's
      return { asked, error: `${node.id}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (answer === null) return { asked, cancelled: true };
    asked.push({ kind: req.kind, ...(req.name ? { name: req.name } : {}), waitedMs: Date.now() - started });
    if (req.kind === "value") vars[req.name!] = answer;
  }
  return { asked };
}

// -- walking the flow -----------------------------------------------------

export type StopReason =
  | "end"
  | "failed"
  | "maxSteps"
  /** Several branches, and nothing to choose between them — a condition we can't evaluate. */
  | "ambiguous"
  /** The node branches on status, but the status it actually returned isn't drawn. */
  | "unmodelled"
  | "aborted"
  /** A person was asked something mid-run (FML-26) and chose to stop. */
  | "cancelled";

export interface RunOptions {
  transport: Transport;
  /**
   * Seed values seeded over the doc's `@vars` — this is where run-time inputs
   * and secrets come in, which is exactly why they never live in the file.
   */
  vars?: Record<string, string>;
  /** Node to start from. Defaults to the first node nothing points at. */
  start?: string;
  /** Cycle guard — these graphs loop back on purpose. */
  maxSteps?: number;
  /** Drives `ui` nodes. Absent: they're skipped (not failed) — see runUiNode. */
  ui?: UiDriver;
  /** Answers `ask.<name>` / `pause` (FML-26). Absent: a step that needs a person fails, saying so. */
  ask?: AskHandler;
  /**
   * Stop at the first failed step. Off by default: a status that has a drawn
   * edge is a *modelled* outcome — `-404>` exists to be walked — so the run
   * follows it and you see the whole sad path, while the step (and the run)
   * still scores red. Turn this on for fail-fast.
   *
   * A step with no response at all still stops the walk regardless: a request
   * that never went out leaves no status to route on.
   */
  stopOnFailure?: boolean;
  signal?: AbortSignal;
  /**
   * Called just before a node is attempted, and as each step finishes, and as
   * each edge is followed — this is what drives live status on the canvas.
   *
   * **Awaited.** A caller that returns a promise holds the walk until it
   * resolves, which is how the UI paces a run slow enough to watch without a
   * single `setTimeout` living in here. Return nothing for full speed.
   */
  onStepStart?: (node: FmlNode) => void | Promise<void>;
  onStep?: (step: StepResult) => void | Promise<void>;
  onEdge?: (edge: FmlEdge) => void | Promise<void>;
}

export interface RunResult {
  ok: boolean;
  steps: StepResult[];
  /** The variable store as it ended up — every capture, in one flat scope. */
  vars: Record<string, string>;
  stoppedBecause: StopReason;
  /** Set when the walk stopped because it couldn't choose an outgoing edge. */
  ambiguousAt?: string;
  /** The status that had nowhere to go, for `unmodelled`. */
  unmodelledStatus?: number;
  /** The node whose question the person declined, for `cancelled`. */
  cancelledAt?: string;
}

function outgoing(edges: FmlEdge[], nodeId: string): FmlEdge[] {
  return edges.filter((e) => e.source === nodeId);
}

/**
 * Which edge to follow out of a node.
 *
 * After an `api` node the status picks the branch — that is what `-200>` /
 * `-404>` mean. Otherwise an unlabelled edge, or a lone outgoing edge whatever
 * its label, is unambiguous. Anything else needs a condition we can't evaluate
 * yet, so the run stops and says so rather than guessing a path and reporting
 * a green test that never ran the branch you cared about.
 */
export function chooseEdge(edges: FmlEdge[], status?: number): FmlEdge | undefined {
  if (edges.length === 0) return undefined;
  if (status !== undefined) {
    const matched = edges.find((e) => isStatusLabel(e.label) && statusMatches(e.label, status));
    if (matched) return matched;
  }
  const unlabelled = edges.filter((e) => e.label.trim() === "");
  if (unlabelled.length === 1) return unlabelled[0];
  if (edges.length === 1) return edges[0];
  return undefined;
}

/** The node nothing points at — where a journey naturally begins. */
export function startNode(doc: FmlDoc): FmlNode | undefined {
  const targeted = new Set(doc.edges.map((e) => e.target));
  return doc.nodes.find((n) => !targeted.has(n.id)) ?? doc.nodes[0];
}

/**
 * Walk a doc, sending every `api` node it reaches, threading captured values
 * through the run's single variable store.
 *
 * Scope note: that store is flat and doc-agnostic on purpose. The open
 * "does a capture cross a `flow` portal?" question in flow-execution.md is a
 * *routing* decision — whether the walk steps into the portal's doc — not a
 * variables one. Whenever routing says yes, the values are already there.
 */
export async function runFlow(doc: FmlDoc, opts: RunOptions): Promise<RunResult> {
  const vars: Record<string, string> = { ...doc.vars, ...(opts.vars ?? {}) };
  const steps: StepResult[] = [];
  const maxSteps = opts.maxSteps ?? 50;

  const first = opts.start ? doc.nodes.find((n) => n.id === opts.start) : startNode(doc);
  if (!first) return { ok: true, steps, vars, stoppedBecause: "end" };

  let current: FmlNode | undefined = first;
  let stoppedBecause: StopReason = "end";
  let ambiguousAt: string | undefined;
  let unmodelledStatus: number | undefined;
  let cancelledAt: string | undefined;

  while (current) {
    if (opts.signal?.aborted) {
      stoppedBecause = "aborted";
      break;
    }
    if (steps.length >= maxSteps) {
      stoppedBecause = "maxSteps";
      break;
    }

    await opts.onStepStart?.(current);
    const person = await askPerson(current, vars, opts.ask, opts.signal);
    if (person.cancelled) {
      stoppedBecause = "cancelled";
      cancelledAt = current.id;
      break;
    }
    const asked = person.asked.length > 0 ? { asked: person.asked } : {};
    const step: StepResult = person.error
      ? { nodeId: current.id, type: current.type, passthrough: false, captures: [], asserts: [], ok: false, failedOn: "ask", error: person.error, ...asked }
      : { ...(await runNode(current, doc.meta, vars, opts.transport, opts.signal, opts.ui)), ...asked };
    steps.push(step);
    await opts.onStep?.(step);

    // No response means nothing to route on — an unbuildable request, a
    // missing variable, a dead host. That always ends the walk. So does a
    // ui action that failed: the page is in an unknown state, and every
    // step after it would fail for that reason, not its own.
    // Nobody to answer a question leaves the step's inputs missing — same.
    if (!step.ok && (opts.stopOnFailure || step.failedOn === "request" || step.failedOn === "ui" || step.failedOn === "ask")) {
      stoppedBecause = "failed";
      break;
    }

    const outs = outgoing(doc.edges, current.id);
    const next: FmlEdge | undefined = chooseEdge(outs, step.response?.status);
    if (next) await opts.onEdge?.(next);
    if (!next) {
      if (outs.length > 1) {
        // Two different dead ends, worth telling apart. If this node branches
        // on status and simply has no edge for the one that came back, the
        // flow just doesn't model that outcome — that's a gap in the diagram,
        // not a tool that couldn't decide. Calling both "ambiguous" made a
        // missing `-403>` look like a bug in the runner.
        const branchesOnStatus = outs.some((e) => isStatusLabel(e.label));
        if (step.response && branchesOnStatus) {
          stoppedBecause = "unmodelled";
          unmodelledStatus = step.response.status;
        } else {
          stoppedBecause = "ambiguous";
        }
        ambiguousAt = current.id;
      }
      break;
    }
    current = doc.nodes.find((n) => n.id === next.target);
  }

  return {
    // Red if any step failed, or if the walk couldn't finish honestly.
    ok:
      steps.every((s) => s.ok) &&
      stoppedBecause !== "ambiguous" &&
      stoppedBecause !== "unmodelled" &&
      stoppedBecause !== "maxSteps" &&
      stoppedBecause !== "cancelled",
    steps,
    vars,
    stoppedBecause,
    ...(ambiguousAt ? { ambiguousAt } : {}),
    ...(unmodelledStatus !== undefined ? { unmodelledStatus } : {}),
    ...(cancelledAt ? { cancelledAt } : {}),
  };
}

/**
 * Everything a run needs that the file can't supply — the run-time inputs and
 * secrets. Ask for these before starting, and a run never dies half way
 * through on a missing `{password}`.
 */
export function requiredInputs(doc: FmlDoc): string[] {
  const supplied = new Set(Object.keys(doc.vars));
  for (const node of doc.nodes) {
    for (const key of Object.keys(node.data)) {
      if (key.startsWith("capture.")) supplied.add(key.slice("capture.".length));
      // Asked mid-run (FML-26), so not needed before it starts.
      if (key.startsWith("ask.")) supplied.add(key.slice("ask.".length));
    }
  }
  const needed: string[] = [];
  for (const node of doc.nodes) {
    // Only `api` and `ui` nodes act, so only their `{name}`s are inputs a run
    // actually needs. A `{name}` sitting on a `page` node is documentation.
    if (node.type !== "api" && node.type !== "ui") continue;
    for (const value of Object.values(node.data)) {
      for (const m of value.matchAll(VAR_RE)) {
        const name = m[1]!;
        if (!supplied.has(name) && !needed.includes(name)) needed.push(name);
      }
    }
  }
  return needed;
}
