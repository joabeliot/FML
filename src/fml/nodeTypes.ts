// FML — the canonical node vocabulary.
//
// A node's `type` is what makes a diagram *mean* something: it decides how the
// node renders, what keys it is expected to carry, and — once flows execute —
// what the runner does when it reaches that node. Five types cover an app flow:
//
//   page      something a person sees
//   api       an HTTP request the app makes
//   decision  a branch on a condition
//   event     something that happens *to* the app (push, deep link, webhook)
//   flow      a portal to another doc — the @fof / @doc drill-down
//
// Anything else still parses and still draws (grey, untyped) — it is a warning
// in loose mode and an error in strict, never a hard stop. The vocabulary is a
// standard, not a cage.
//
// `expects` holds only the keys a node cannot do its job without: an `api` that
// names no request cannot be sent, a `flow` portal that names no doc leads
// nowhere. Everything else — a page's route, a decision's condition — is an
// enrichment and lives in `optional`, surfaced as a suggestion rather than a
// complaint. A sketch should stay cheap to write: `Login = page` is complete.
//
// In strict mode a missing expected key is a warning; nothing is ever required
// to draw. The `api` key set is deliberately execution-ready — see
// lore/ideas/flow-execution.md — so diagrams written today can be *run* later
// without a rewrite.

export interface FmlTypeSpec {
  /** The literal written after `=` in `@nodes`. */
  type: string;
  /** Singular display name. */
  label: string;
  /** Sidebar group heading. */
  plural: string;
  /** One line, shown in the property panel. */
  summary: string;
  /** CSS custom property holding this type's accent colour. */
  color: string;
  /** Keys the type should carry; a missing one is a strict-mode warning. */
  expects: readonly string[];
  /** Keys that are meaningful for the type but never expected. */
  optional: readonly string[];
}

/** Type given to a node the parser had to invent (an undeclared flow ref). */
export const UNTYPED = "unknown";

export const NODE_TYPES: readonly FmlTypeSpec[] = [
  {
    type: "page",
    label: "Page",
    plural: "Pages",
    summary: "A screen the user lands on.",
    color: "var(--color-page)",
    expects: [],
    optional: ["route", "title", "image", "note"],
  },
  {
    type: "api",
    label: "API",
    plural: "APIs",
    summary: "An HTTP request the app makes.",
    color: "var(--color-api)",
    expects: ["method", "path"],
    // Execution-ready: header.<Name>, query.<name> and capture.<var> are
    // prefixes rather than literal keys — see isExecKey below.
    // `base` overrides `@meta base` for this one node — a flow that spans
    // services (auth on one host, billing on another) without splitting into
    // multiple docs. See lore/ideas/flow-execution.md.
    optional: ["url", "base", "body", "auth", "expect", "note"],
  },
  {
    type: "decision",
    label: "Decision",
    plural: "Decisions",
    summary: "A branch — outgoing edges are the answers.",
    color: "var(--color-decision)",
    // The outgoing edge labels usually *are* the condition, so naming it
    // separately is a clarification, not a requirement.
    expects: [],
    optional: ["condition", "note"],
  },
  {
    type: "event",
    label: "Event",
    plural: "Events",
    summary: "Something that happens to the app, not in it.",
    color: "var(--color-event)",
    expects: [],
    optional: ["source", "payload", "note"],
  },
  {
    type: "flow",
    label: "Flow",
    plural: "Flows",
    summary: "A portal into another doc.",
    color: "var(--color-flow)",
    expects: ["doc"],
    optional: ["note"],
  },
] as const;

const BY_TYPE = new Map(NODE_TYPES.map((t) => [t.type, t]));

export const NODE_TYPE_NAMES: readonly string[] = NODE_TYPES.map((t) => t.type);

export function nodeTypeSpec(type: string): FmlTypeSpec | undefined {
  return BY_TYPE.get(type);
}

/** True for a type in the standard. `unknown` is not — it is the absence of one. */
export function isKnownType(type: string): boolean {
  return BY_TYPE.has(type);
}

/**
 * Repeatable execution keys are written with a dotted suffix — `header.Accept`,
 * `query.page`, `capture.token` — so they can appear any number of times in one
 * block. Recognised here so tooling can tell a real key from a typo.
 */
export const EXEC_KEY_PREFIXES = ["header", "query", "capture"] as const;

export function isExecKey(key: string): boolean {
  const dot = key.indexOf(".");
  if (dot <= 0) return false;
  return (EXEC_KEY_PREFIXES as readonly string[]).includes(key.slice(0, dot));
}

/**
 * Expected keys this node is missing. `path`/`url` are alternatives — either
 * satisfies the other — so an `api` node with a full `url` is not nagged.
 */
export function missingKeys(type: string, data: Record<string, string>): string[] {
  const spec = BY_TYPE.get(type);
  if (!spec) return [];
  const has = (k: string) => data[k] !== undefined && data[k]!.trim() !== "";
  return spec.expects.filter((k) => {
    if (has(k)) return false;
    if (k === "path" && has("url")) return false;
    return true;
  });
}
