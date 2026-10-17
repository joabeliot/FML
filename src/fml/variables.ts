// FML — variable resolution.
//
// `{name}` inside any value string is a reference to a variable. It is
// satisfied one of two ways:
//   - `@vars` declares a literal default — known right now, in the file.
//   - `capture.<name>` on an `api` node pulls it out of that node's response —
//     known only once the flow actually runs.
//   - `ask.<name>` on any node asks a person for it mid-run (FML-26).
// Anything referenced but neither declared nor captured is a run-time input:
// nothing to resolve today (no runner yet — see lore/ideas/flow-execution.md),
// but naming it here is what lets the property panel tell you "this will need
// a value when you run it" instead of silently doing nothing with `{password}`.

import type { FmlDoc, FmlNode } from "./types.ts";

const VAR_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export type VarSource = "vars" | "capture" | "ask";

export interface ResolvedVar {
  name: string;
  source: VarSource;
  /** The literal default, for a `vars` source. Absent for `capture` — that
   *  value only exists once a request actually runs. */
  value?: string;
  /** The node whose `capture.<name>` (or `ask.<name>`) defines this. */
  capturedBy?: string;
}

/** Every `{name}` reference inside one value string, in order, de-duplicated. */
export function varsInValue(value: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of value.matchAll(VAR_RE)) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Every `{name}` reference anywhere in one node's data, de-duplicated. */
export function varsInNode(node: FmlNode): string[] {
  const names = new Set<string>();
  for (const value of Object.values(node.data)) {
    for (const name of varsInValue(value)) names.add(name);
  }
  return [...names];
}

/**
 * Every variable this doc can satisfy — its `@vars` defaults plus whatever any
 * node's `capture.<name>` key defines. `@vars` wins if a name is somehow both
 * (a declared default is more specific than "some node captures this later").
 */
export function resolveVariables(doc: FmlDoc): Map<string, ResolvedVar> {
  const resolved = new Map<string, ResolvedVar>();

  for (const node of doc.nodes) {
    for (const key of Object.keys(node.data)) {
      const source = key.startsWith("capture.") ? "capture" : key.startsWith("ask.") ? "ask" : null;
      if (!source) continue;
      const name = key.slice(source.length + 1);
      if (name && !resolved.has(name)) {
        resolved.set(name, { name, source, capturedBy: node.id });
      }
    }
  }

  for (const [name, value] of Object.entries(doc.vars)) {
    resolved.set(name, { name, source: "vars", value });
  }

  return resolved;
}

export interface NodeVarUsage {
  name: string;
  /** `undefined` — referenced, but neither declared nor captured anywhere. */
  resolved: ResolvedVar | undefined;
}

/** What one node's `{name}` references resolve to, given the doc's full picture. */
export function nodeVarUsage(node: FmlNode, resolved: Map<string, ResolvedVar>): NodeVarUsage[] {
  return varsInNode(node).map((name) => ({ name, resolved: resolved.get(name) }));
}
