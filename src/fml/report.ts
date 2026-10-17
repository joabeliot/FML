// FML — the machine-readable run result.
//
// `runFlow` returns everything that happened; this turns it into something a
// CI job, a manager script or another agent can act on without re-deriving
// it: which node failed, the exact request and response, *which* check
// failed (status, capture or assert), timings — with secrets redacted.
//
// Redaction is by value, not by key name alone. A token lands in a header, a
// URL, a body, a later capture; masking only a field called `token` would
// leak it everywhere else. So every value known to be secret is scrubbed from
// every string in the report, wherever it ended up.
//
// Zero dependencies, like the rest of `src/fml/`.

import type { AssertResult, CaptureResult, HttpRequest, HttpResponse, RunResult, StepResult, StopReason } from "./run.ts";

/** Variable names that are treated as secrets without being told. */
const SECRETISH = /(token|password|passwd|secret|key|auth|bearer|cookie|session|credential|otp)/i;

/** Headers whose value is always hidden, whatever's in them. */
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);

/** Shorter values aren't redacted — scrubbing every "1" out of a report helps no one. */
const MIN_SECRET_LENGTH = 4;

export function isSecretName(name: string): boolean {
  return SECRETISH.test(name);
}

export type Redactor = (text: string) => string;

/**
 * A function that replaces every occurrence of every secret value with
 * `[redacted:<name>]`. Longest values first, so a secret that contains
 * another is replaced whole.
 */
export function makeRedactor(secrets: Record<string, string>): Redactor {
  const entries = Object.entries(secrets)
    .filter(([, v]) => v.length >= MIN_SECRET_LENGTH)
    .sort(([, a], [, b]) => b.length - a.length);
  if (entries.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [name, value] of entries) out = out.split(value).join(`[redacted:${name}]`);
    return out;
  };
}

/**
 * Every secret a run touched: explicitly declared ones, plus any variable —
 * supplied or captured — whose name looks secret.
 */
export function collectSecrets(
  vars: Record<string, string>,
  declared: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = { ...declared };
  for (const [name, value] of Object.entries(vars)) {
    if (isSecretName(name) && out[name] === undefined) out[name] = value;
  }
  return out;
}

export interface ReportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ReportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The body's size before any truncation, in bytes. */
  bodyBytes: number;
  bodyTruncated?: true;
}

export interface ReportStep {
  nodeId: string;
  type: string;
  ok: boolean;
  passthrough: boolean;
  durationMs?: number;
  error?: string;
  expect?: string;
  request?: ReportRequest;
  response?: ReportResponse;
  captures: CaptureResult[];
  asserts: AssertResult[];
}

/** What, precisely, made the run red. */
export type FailureKind =
  | "request" // no response at all: unbuildable request, missing variable, dead host
  | "status" // `expect` didn't match
  | "capture" // a capture found nothing
  | "assert" // an `assert.*` failed
  | "unmodelled" // a status with no drawn edge
  | "ambiguous" // several edges, nothing to choose with
  | "maxSteps"; // the cycle guard tripped

export interface RunFailure {
  kind: FailureKind;
  nodeId: string;
  message: string;
  request?: ReportRequest;
  response?: ReportResponse;
  expect?: string;
  capture?: CaptureResult;
  assertion?: AssertResult;
}

export interface RunReport {
  /** Bumped on any breaking change to this shape. */
  schema: 1;
  ok: boolean;
  file?: string;
  doc: string;
  startedAt?: string;
  durationMs?: number;
  stoppedBecause: StopReason;
  summary: { steps: number; requests: number; passed: number; failed: number };
  /** The first thing that went wrong — what a fixer reads first. Absent on a pass. */
  failure?: RunFailure;
  steps: ReportStep[];
  /** The variable store as the run left it, redacted. */
  vars: Record<string, string>;
}

export interface ReportOptions {
  doc: string;
  file?: string;
  startedAt?: string;
  durationMs?: number;
  /** Values to scrub, by name — see `collectSecrets`. */
  secrets?: Record<string, string>;
  /** Longest body kept per request/response, in characters. Default 64 KiB. */
  maxBodyChars?: number;
}

const DEFAULT_MAX_BODY = 64 * 1024;

function byteLength(res: HttpResponse): number {
  return res.bytes?.length ?? new TextEncoder().encode(res.body).length;
}

/** Turn a finished run into its JSON report. Pure — the caller decides where it goes. */
export function buildReport(run: RunResult, opts: ReportOptions): RunReport {
  const redact = makeRedactor(opts.secrets ?? {});
  const max = opts.maxBodyChars ?? DEFAULT_MAX_BODY;

  const headers = (h: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? "[redacted]" : redact(v);
    return out;
  };
  const request = (r: HttpRequest): ReportRequest => ({
    method: r.method,
    url: redact(r.url),
    headers: headers(r.headers),
    ...(r.body === undefined ? {} : { body: redact(r.body) }),
  });
  const response = (r: HttpResponse): ReportResponse => {
    const truncated = r.body.length > max;
    return {
      status: r.status,
      headers: headers(r.headers),
      body: redact(truncated ? r.body.slice(0, max) : r.body),
      bodyBytes: byteLength(r),
      ...(truncated ? { bodyTruncated: true as const } : {}),
    };
  };
  const capture = (c: CaptureResult): CaptureResult => ({
    ...c,
    ...(c.value === undefined ? {} : { value: redact(c.value) }),
  });
  const assertion = (a: AssertResult): AssertResult => ({
    ...a,
    expr: redact(a.expr),
    ...(a.actual === undefined ? {} : { actual: redact(a.actual) }),
    ...(a.message === undefined ? {} : { message: redact(a.message) }),
  });

  const step = (s: StepResult): ReportStep => ({
    nodeId: s.nodeId,
    type: s.type,
    ok: s.ok,
    passthrough: s.passthrough,
    ...(s.durationMs === undefined ? {} : { durationMs: s.durationMs }),
    ...(s.error === undefined ? {} : { error: redact(s.error) }),
    ...(s.expect === undefined ? {} : { expect: s.expect }),
    ...(s.request ? { request: request(s.request) } : {}),
    ...(s.response ? { response: response(s.response) } : {}),
    captures: s.captures.map(capture),
    asserts: s.asserts.map(assertion),
  });

  const steps = run.steps.map(step);
  const requests = run.steps.filter((s) => !s.passthrough);

  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(run.vars)) vars[k] = redact(v);

  const failure = firstFailure(run, steps);
  return {
    schema: 1,
    ok: run.ok,
    ...(opts.file === undefined ? {} : { file: opts.file }),
    doc: opts.doc,
    ...(opts.startedAt === undefined ? {} : { startedAt: opts.startedAt }),
    ...(opts.durationMs === undefined ? {} : { durationMs: opts.durationMs }),
    stoppedBecause: run.stoppedBecause,
    summary: {
      steps: run.steps.length,
      requests: requests.length,
      passed: requests.filter((s) => s.ok).length,
      failed: requests.filter((s) => !s.ok).length,
    },
    ...(failure ? { failure } : {}),
    steps,
    vars,
  };
}

/** Classify the first failing step, or the walk itself when no step failed. */
function firstFailure(run: RunResult, steps: ReportStep[]): RunFailure | undefined {
  const index = run.steps.findIndex((s) => !s.ok);
  const raw = run.steps[index];
  const bad = steps[index];
  if (raw && bad) {
    const base = {
      nodeId: bad.nodeId,
      message: bad.error ?? `${bad.nodeId} failed`,
      ...(bad.request ? { request: bad.request } : {}),
      ...(bad.response ? { response: bad.response } : {}),
      ...(bad.expect ? { expect: bad.expect } : {}),
    };
    const kind = raw.failedOn ?? (bad.response ? "status" : "request");
    if (kind === "capture") {
      const capture = bad.captures.find((c) => !c.ok);
      return { kind, ...base, ...(capture ? { capture } : {}) };
    }
    if (kind === "assert") {
      const assertion = bad.asserts.find((a) => !a.ok);
      return { kind, ...base, ...(assertion ? { assertion } : {}) };
    }
    return { kind, ...base };
  }
  if (run.ok) return undefined;
  const at = run.ambiguousAt ?? steps[steps.length - 1]?.nodeId ?? "";
  if (run.stoppedBecause === "unmodelled") {
    return {
      kind: "unmodelled",
      nodeId: at,
      message: `"${at}" returned ${run.unmodelledStatus} and no edge leaves it for that status`,
    };
  }
  if (run.stoppedBecause === "ambiguous") {
    return { kind: "ambiguous", nodeId: at, message: `"${at}" has several outgoing edges and no status to pick one` };
  }
  return { kind: "maxSteps", nodeId: at, message: `stopped after ${run.steps.length} steps — the cycle guard` };
}
