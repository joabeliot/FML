// Visual identity for a node type. The vocabulary itself lives in
// `src/fml/nodeTypes.ts`; this is only how it looks.

import { nodeTypeSpec } from "../fml/index.ts";

/** Grey — an untyped node, or one using a type outside the standard. */
export const OFF_STANDARD = "#8a8a8a";

// Trace direction colours (badge-click spotlight) — deliberately not reused
// from the type palette above, so "blue = incoming, orange = outgoing" always
// means the same thing regardless of what type the node happens to be. Same
// convention as inbound/outbound traffic in most network dashboards.
export const TRACE_IN = "#5b9dd9";
export const TRACE_OUT = "#e8935a";

export function kindColor(kind: string): string {
  return nodeTypeSpec(kind)?.color ?? OFF_STANDARD;
}

/** How a type is labelled on a node card and in the sidebar. */
export function kindTag(kind: string): string {
  return kind.toLowerCase();
}

/** Sidebar group heading for a type. */
export function kindPlural(kind: string): string {
  const spec = nodeTypeSpec(kind);
  if (spec) return spec.plural;
  if (kind === "unknown") return "Untyped";
  return `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}`;
}

/**
 * A 16×16 glyph per type, drawn on a 0–16 grid with `currentColor`.
 * Shapes carry the meaning: a framed screen, an exchange, a fork, a burst, a
 * doorway. Kept as raw path data so the node card can inline them without a
 * component boundary per icon.
 */
const GLYPH: Record<string, string> = {
  // a window: frame + title bar
  page: "M2.5 3.5h11v9h-11z M2.5 6.5h11",
  // request out, response back
  api: "M3 5.5h8.5 M9 3l2.5 2.5L9 8 M13 10.5H4.5 M7 8l-2.5 2.5L7 13",
  // a fork in the path
  decision: "M8 13.5V8.5 M8 8.5L3.5 4 M8 8.5L12.5 4",
  // a burst — something arriving from outside
  event:
    "M8 2.5v3 M8 10.5v3 M2.5 8h3 M10.5 8h3 M4.4 4.4l2.1 2.1 M9.5 9.5l2.1 2.1 M11.6 4.4L9.5 6.5 M6.5 9.5l-2.1 2.1",
  // a doorway you can step through
  flow: "M4 2.5h8v11H4z M9.7 8.2h.01",
  // a pointer clicking — something done *to* a screen
  ui: "M4 3l7.5 3.6-3.1 1 2.6 3.9-1.4.9-2.6-3.9-2.3 2.3z",
};

export function kindGlyph(kind: string): string | undefined {
  return GLYPH[kind];
}
