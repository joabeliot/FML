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
}

export type Transport = (req: HttpRequest, signal?: AbortSignal) => Promise<HttpResponse>;

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
 *
 * Returns undefined when the path doesn't lead anywhere — the caller reports
 * that as a failed capture rather than storing an empty string, because a
 * silently-empty `{token}` is the worst possible outcome of a test run.
 */
export function readPath(res: HttpResponse, path: string): string | undefined {
  const expr = path.trim();
  if (expr === "status") return String(res.status);
  if (expr === "$" || expr === "") return res.body;

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

  for (const token of pathTokens(expr)) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
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

export interface StepResult {
  nodeId: string;
  type: string;
  /** No request was sent — a `page`/`decision`/`event`/`flow` node just routes. */
  passthrough: boolean;
  request?: HttpRequest;
  response?: HttpResponse;
  captures: CaptureResult[];
  /** The node's `expect` pattern, when it declared one. */
  expect?: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
}

/** Every `capture.<name>` on a node, in declaration order. */
function captureKeys(node: FmlNode): Array<[string, string]> {
  return Object.entries(node.data)
    .filter(([k]) => k.startsWith("capture."))
    .map(([k, v]) => [k.slice("capture.".length), v]);
}

/**
 * Send one `api` node and fold its captures into `vars` (mutated in place, so
 * the next node in the same run sees them — that threading *is* the feature).
 *
 * Captures run before the `expect` assertion, so a failing step still tells
 * you what came back instead of throwing the response away.
 */
export async function runNode(
  node: FmlNode,
  meta: Record<string, string>,
  vars: Record<string, string>,
  transport: Transport,
  signal?: AbortSignal,
): Promise<StepResult> {
  const base: StepResult = { nodeId: node.id, type: node.type, passthrough: false, captures: [], ok: true };

  if (node.type !== "api") return { ...base, passthrough: true };

  const built = buildRequest(node, meta, vars);
  if (built.error) return { ...base, ok: false, error: built.error };
  if (built.missing.length > 0) {
    return {
      ...base,
      ok: false,
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
      durationMs: Date.now() - started,
      error: `${node.id}: request failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const durationMs = Date.now() - started;

  const captures: CaptureResult[] = [];
  for (const [name, path] of captureKeys(node)) {
    const value = readPath(response, path);
    captures.push({ name, path, value, ok: value !== undefined });
    if (value !== undefined) vars[name] = value;
  }

  const expect = node.data.expect?.trim();
  const statusOk = !expect || statusMatches(expect, response.status);
  const failedCapture = captures.find((c) => !c.ok);

  let error: string | undefined;
  if (!statusOk) error = `${node.id}: expected ${expect}, got ${response.status}`;
  else if (failedCapture) error = `${node.id}: capture.${failedCapture.name} found nothing at "${failedCapture.path}"`;

  return {
    ...base,
    request,
    response,
    captures,
    ...(expect ? { expect } : {}),
    durationMs,
    ok: !error,
    ...(error ? { error } : {}),
  };
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
  | "aborted";

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
    const step: StepResult = await runNode(current, doc.meta, vars, opts.transport, opts.signal);
    steps.push(step);
    await opts.onStep?.(step);

    // No response means nothing to route on — an unbuildable request, a
    // missing variable, a dead host. That always ends the walk.
    if (!step.ok && (opts.stopOnFailure || (!step.passthrough && !step.response))) {
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
      stoppedBecause !== "maxSteps",
    steps,
    vars,
    stoppedBecause,
    ...(ambiguousAt ? { ambiguousAt } : {}),
    ...(unmodelledStatus !== undefined ? { unmodelledStatus } : {}),
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
    }
  }
  const needed: string[] = [];
  for (const node of doc.nodes) {
    // Only `api` nodes send anything, so only their `{name}`s are inputs a run
    // actually needs. A `{name}` sitting on a `page` node is documentation.
    if (node.type !== "api") continue;
    for (const value of Object.values(node.data)) {
      for (const m of value.matchAll(VAR_RE)) {
        const name = m[1]!;
        if (!supplied.has(name) && !needed.includes(name)) needed.push(name);
      }
    }
  }
  return needed;
}
