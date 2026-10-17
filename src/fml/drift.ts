// FML — drift between flows and the API's OpenAPI spec.
//
// A flow describes requests; a spec describes what the API actually offers.
// Nothing kept the two honest — Flock's catalog.fml described endpoints that
// were later built differently and no check noticed. This compares them:
//
//   error    an `api` node calls a path the spec doesn't have, or a method
//            the path doesn't support — the flow is wrong or the API moved
//   warning  a status the flow expects or branches on that the spec never
//            documents — maybe real (specs are often incomplete), maybe drift
//   coverage spec operations no flow exercises — not drift, but the gap
//            you'd want a flow for
//
// Input is the spec as a plain object — OpenAPI 3.x or Swagger 2.0. Parsing
// JSON or YAML is the caller's job, so this stays dependency-free.

import { isStatusLabel } from "./run.ts";
import type { FmlDoc, FmlNode } from "./types.ts";

export type DriftSeverity = "error" | "warning";

export type DriftKind = "unknown-path" | "unknown-method" | "undocumented-status" | "unresolvable";

export interface DriftFinding {
  severity: DriftSeverity;
  kind: DriftKind;
  doc: string;
  nodeId: string;
  /** The request as the flow writes it, e.g. `GET /users/{userId}`. */
  request: string;
  /** The spec operation it matched, e.g. `GET /users/{id}` — absent when none did. */
  operation?: string;
  message: string;
}

export interface DriftReport {
  findings: DriftFinding[];
  /** Spec operations (`METHOD /path`) and whether any flow reached them. */
  coverage: { total: number; exercised: string[]; unexercised: string[] };
  /**
   * Nodes not compared because they call a different host than the spec
   * describes — a multi-host flow checked against one service's spec.
   */
  skipped: Array<{ doc: string; nodeId: string; origin: string }>;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

interface SpecOperation {
  method: string;
  path: string;
  segments: string[];
  /** Documented response keys: "200", "2XX", "default". */
  responses: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Split `/a/b/` into ["a","b"], dropping the query string. */
function segmentsOf(path: string): string[] {
  return path.split("?")[0]!.split("/").filter((s) => s !== "");
}

/** Path prefixes the spec serves from: Swagger's basePath, OpenAPI's servers[].url paths. */
function specBases(spec: Record<string, unknown>): string[][] {
  const out: string[][] = [];
  if (typeof spec.basePath === "string") out.push(segmentsOf(spec.basePath));
  if (Array.isArray(spec.servers)) {
    for (const s of spec.servers) {
      if (!isRecord(s) || typeof s.url !== "string") continue;
      // A server url may be absolute or relative, and may hold {vars}.
      const path = s.url.replace(/^[a-z]+:\/\/[^/]+/i, "");
      out.push(segmentsOf(path));
    }
  }
  out.push([]);
  return out;
}

/**
 * Hosts the spec describes (lowercase), from Swagger's `host` or OpenAPI's
 * absolute `servers[].url`s. Empty when the spec doesn't say — then every
 * node is compared.
 */
function specHosts(spec: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof spec.host === "string") out.push(spec.host.toLowerCase());
  if (Array.isArray(spec.servers)) {
    for (const s of spec.servers) {
      if (!isRecord(s) || typeof s.url !== "string") continue;
      const m = s.url.match(/^[a-z]+:\/\/([^/]+)/i);
      if (m) out.push(m[1]!.toLowerCase());
    }
  }
  return out;
}

/** The host a node's request goes to, when it's knowable without running (no `{var}` in it). */
function nodeHost(node: FmlNode, meta: Record<string, string>): string | undefined {
  const source = node.data.url?.trim() || (/^[a-z]+:\/\//i.test(node.data.path?.trim() ?? "") ? node.data.path!.trim() : "") || node.data.base?.trim() || meta.base || "";
  const m = source.match(/^[a-z]+:\/\/([^/]+)/i);
  if (!m || m[1]!.includes("{")) return undefined;
  return m[1]!.toLowerCase();
}

function operationsOf(spec: Record<string, unknown>): SpecOperation[] {
  const ops: SpecOperation[] = [];
  if (!isRecord(spec.paths)) return ops;
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const responses = isRecord(op.responses) ? Object.keys(op.responses) : [];
      ops.push({ method: method.toUpperCase(), path, segments: segmentsOf(path), responses });
    }
  }
  return ops;
}

const isParam = (seg: string): boolean => /^\{[^}]+\}$/.test(seg);
/** A flow segment that's partly or wholly a `{variable}` — its value is unknown until run time. */
const isFlowVar = (seg: string): boolean => seg.includes("{");

/**
 * How well a spec path matches a flow path, segment by segment: undefined
 * for no match, otherwise a score where literal-on-literal beats a template
 * — so `/users/me` prefers a spec `/users/me` over `/users/{id}`.
 */
function matchScore(spec: string[], flow: string[]): number | undefined {
  if (spec.length !== flow.length) return undefined;
  let score = 0;
  for (let i = 0; i < spec.length; i++) {
    const s = spec[i]!;
    const f = flow[i]!;
    if (isParam(s)) continue;
    if (isFlowVar(f)) continue; // `{x}` in the flow could be anything at run time
    if (s !== f) return undefined;
    score++;
  }
  return score;
}

/** The request path a node will hit, without origin or query, as segments. */
function nodePath(node: FmlNode, meta: Record<string, string>): string[] | undefined {
  const url = node.data.url?.trim();
  if (url) return segmentsOf(url.replace(/^[a-z]+:\/\/[^/]+/i, ""));
  const path = node.data.path?.trim();
  if (!path) return undefined;
  if (/^[a-z]+:\/\//i.test(path)) return segmentsOf(path.replace(/^[a-z]+:\/\/[^/]+/i, ""));
  // A base can carry a path prefix of its own (`https://api.x.com/v1`).
  const base = (node.data.base?.trim() || meta.base || "").replace(/^[a-z]+:\/\/[^/]+/i, "");
  return [...segmentsOf(base), ...segmentsOf(path)];
}

/** Statuses a node commits to: its `expect`, plus every status label drawn out of it. */
function flowStatuses(node: FmlNode, doc: FmlDoc): string[] {
  const out: string[] = [];
  const add = (pattern: string) => {
    for (const part of pattern.split(",")) {
      const p = part.trim();
      if (p !== "" && !out.includes(p)) out.push(p);
    }
  };
  const expect = node.data.expect?.trim();
  if (expect && isStatusLabel(expect)) add(expect);
  for (const e of doc.edges) if (e.source === node.id && isStatusLabel(e.label)) add(e.label);
  return out;
}

/** Does any documented response cover this flow status pattern (`404`, `2xx`, `200-204`)? */
function documented(pattern: string, responses: string[]): boolean {
  if (responses.some((r) => r.toLowerCase() === "default")) return true;
  const codes = responses.filter((r) => /^\d{3}$/.test(r)).map(Number);
  const classes = responses.filter((r) => /^\dxx$/i.test(r)).map((r) => Number(r[0]));
  const covers = (code: number) => codes.includes(code) || classes.includes(Math.floor(code / 100));

  const p = pattern.toLowerCase();
  if (/^\d+$/.test(p)) return covers(Number(p));
  const wildcard = p.match(/^(\d)xx$/);
  if (wildcard) {
    const cls = Number(wildcard[1]);
    return classes.includes(cls) || codes.some((c) => Math.floor(c / 100) === cls);
  }
  const range = p.match(/^(\d+)-(\d+)$/);
  if (range) {
    for (let c = Number(range[1]); c <= Number(range[2]); c++) if (covers(c)) return true;
    return false;
  }
  return false;
}

/**
 * Compare every `api` node in `docs` against an OpenAPI / Swagger spec.
 * Docs reached through `@fof` are included — pass the parsed file's docs.
 */
export function checkDrift(docs: FmlDoc[], spec: unknown): DriftReport {
  const findings: DriftFinding[] = [];
  const root = isRecord(spec) ? spec : {};
  const ops = operationsOf(root);
  const bases = specBases(root);
  const reached = new Set<SpecOperation>();
  const hosts = specHosts(root);
  const skipped: DriftReport["skipped"] = [];

  for (const doc of docs) {
    for (const node of doc.nodes) {
      if (node.type !== "api") continue;
      const method = (node.data.method ?? "GET").trim().toUpperCase();
      const path = nodePath(node, doc.meta);
      const request = `${method} ${node.data.path?.trim() || node.data.url?.trim() || "?"}`;
      const at = { doc: doc.name, nodeId: node.id, request };

      const host = nodeHost(node, doc.meta);
      if (host && hosts.length > 0 && !hosts.includes(host)) {
        skipped.push({ doc: doc.name, nodeId: node.id, origin: host });
        continue;
      }

      if (!path) {
        findings.push({
          ...at,
          severity: "warning",
          kind: "unresolvable",
          message: `${node.id} has no path or url to compare against the spec`,
        });
        continue;
      }

      // Best match over every base prefix the spec serves from.
      let best: { op: SpecOperation; score: number } | undefined;
      for (const prefix of bases) {
        const starts = prefix.every((seg, i) => isParam(seg) || path[i] === seg);
        if (!starts) continue;
        const rest = path.slice(prefix.length);
        for (const op of ops) {
          const score = matchScore(op.segments, rest);
          if (score === undefined) continue;
          // Same path, right method wins over same path, wrong method.
          const weighted = score * 2 + (op.method === method ? 1 : 0);
          if (!best || weighted > best.score) best = { op, score: weighted };
        }
      }

      if (!best) {
        findings.push({
          ...at,
          severity: "error",
          kind: "unknown-path",
          message: `${request} — no path in the spec matches /${path.join("/")}`,
        });
        continue;
      }
      if (best.op.method !== method) {
        const allowed = ops.filter((o) => o.path === best!.op.path).map((o) => o.method);
        findings.push({
          ...at,
          severity: "error",
          kind: "unknown-method",
          operation: `${allowed.join("|")} ${best.op.path}`,
          message: `${request} — the spec's ${best.op.path} supports ${allowed.join(", ")}, not ${method}`,
        });
        continue;
      }

      reached.add(best.op);
      const operation = `${best.op.method} ${best.op.path}`;
      for (const status of flowStatuses(node, doc)) {
        if (documented(status, best.op.responses)) continue;
        findings.push({
          ...at,
          severity: "warning",
          kind: "undocumented-status",
          operation,
          message: `${node.id} expects or branches on ${status}, but ${operation} only documents ${best.op.responses.join(", ") || "no responses"}`,
        });
      }
    }
  }

  const label = (o: SpecOperation) => `${o.method} ${o.path}`;
  return {
    findings,
    coverage: {
      total: ops.length,
      exercised: ops.filter((o) => reached.has(o)).map(label),
      unexercised: ops.filter((o) => !reached.has(o)).map(label),
    },
    skipped,
  };
}
