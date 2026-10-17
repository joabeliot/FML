// RML — RoadMap Language (FML-21).
//
// FML maps an API flow so you can watch the logic run; RML maps a *project*
// so you can see where you are and what's next. Same grammar — the RML file
// is parsed by src/fml/parse.ts with this module's vocabulary — different
// meaning:
//
//   nodes   milestones and features, not screens and requests
//   edges   `A -> B` reads "A unlocks B": B depends on A. A node can depend
//           on several others at once, so it's a DAG, not a tree.
//
//   @nodes
//     auth      = feature
//     billing   = feature
//     launch    = milestone
//
//   @node auth {
//     status: done
//     area: platform
//     description: Sign-in, sessions, password reset
//     fml: auth
//     ticket: FML-11, FML-12
//   }
//
//   @flow
//     auth -> launch
//     billing -> launch
//
// `status` is set by hand (pending | active | done; pending when absent) —
// deliberately not derived from a linked ticket's state, which would make one
// system silently trust another. `fml` and `ticket` are plain references in
// v1: shown, and an `fml` that's loaded in the workspace can be opened, but a
// ticket id isn't resolved against lore's ticket.json.
//
// Zero dependencies, like src/fml/.

import type { FmlDoc, FmlNode, FmlVocabulary } from "../fml/index.ts";

export const RML_TYPES = ["feature", "milestone"] as const;
export const RML_STATUSES = ["pending", "active", "done"] as const;
export type RmlStatus = (typeof RML_STATUSES)[number];

/** The keys an RML node understands. Nothing is required — `x = feature` is a sketch. */
export const RML_KEYS = ["status", "description", "area", "fml", "ticket", "note", "label"] as const;

export const RML_VOCABULARY: FmlVocabulary = {
  names: RML_TYPES,
  isKnown: (type) => (RML_TYPES as readonly string[]).includes(type),
  missing: () => [],
};

export function statusOf(node: FmlNode): RmlStatus {
  const s = node.data.status?.trim().toLowerCase();
  return (RML_STATUSES as readonly string[]).includes(s ?? "") ? (s as RmlStatus) : "pending";
}

/**
 * What a node looks like on the map. `ready` is the one RML adds on top of
 * the written status: pending, but everything it depends on is done — the
 * frontier, "what's next". `locked` is pending with a prerequisite still open.
 */
export type RmlDisplay = "done" | "active" | "ready" | "locked";

export function displayStates(doc: FmlDoc): Map<string, RmlDisplay> {
  const status = new Map(doc.nodes.map((n) => [n.id, statusOf(n)]));
  const deps = new Map<string, string[]>();
  for (const e of doc.edges) deps.set(e.target, [...(deps.get(e.target) ?? []), e.source]);

  const out = new Map<string, RmlDisplay>();
  for (const n of doc.nodes) {
    const s = status.get(n.id)!;
    if (s !== "pending") {
      out.set(n.id, s);
      continue;
    }
    const open = (deps.get(n.id) ?? []).some((d) => status.get(d) !== "done");
    out.set(n.id, open ? "locked" : "ready");
  }
  return out;
}

/** Comma- or space-separated references (`ticket: FML-11, FML-12`). */
export function refsOf(value: string | undefined): string[] {
  return (value ?? "").split(/[,\s]+/).map((r) => r.trim()).filter((r) => r !== "");
}

export interface RmlIssue {
  nodeId: string;
  message: string;
}

/**
 * Roadmap-specific checks the grammar can't make: a status outside the three,
 * a key RML doesn't know (the typo catcher), and a dependency cycle — a
 * milestone that transitively depends on itself can never be reached.
 */
export function checkRoadmap(doc: FmlDoc): RmlIssue[] {
  const issues: RmlIssue[] = [];
  for (const n of doc.nodes) {
    const s = n.data.status?.trim().toLowerCase();
    if (s !== undefined && !(RML_STATUSES as readonly string[]).includes(s)) {
      issues.push({ nodeId: n.id, message: `status "${n.data.status}" isn't one of ${RML_STATUSES.join(", ")}` });
    }
    for (const key of Object.keys(n.data)) {
      if (!(RML_KEYS as readonly string[]).includes(key)) {
        issues.push({ nodeId: n.id, message: `"${key}" isn't an RML key — use ${RML_KEYS.join(", ")}` });
      }
    }
  }

  // Cycle detection — depth-first, reporting each cycle once by its entry node.
  const next = new Map<string, string[]>();
  for (const e of doc.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const state = new Map<string, "open" | "closed">();
  const reported = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    state.set(id, "open");
    for (const to of next.get(id) ?? []) {
      if (state.get(to) === "open") {
        const cycle = [...path.slice(path.indexOf(to)), id, to];
        const key = [...new Set(cycle)].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({ nodeId: to, message: `dependency cycle: ${cycle.join(" → ")}` });
        }
      } else if (!state.has(to)) {
        visit(to, [...path, id]);
      }
    }
    state.set(id, "closed");
  };
  for (const n of doc.nodes) if (!state.has(n.id)) visit(n.id, []);

  return issues;
}

/** Done / total, for the header. Milestones and features count alike. */
export function progress(doc: FmlDoc): { done: number; total: number } {
  return { done: doc.nodes.filter((n) => statusOf(n) === "done").length, total: doc.nodes.length };
}
