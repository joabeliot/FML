// Structural edits to `.fml` source: add / delete / rename a node, add / delete
// an edge. The other half of `fmlEdit.ts` — those functions rewrite something
// that already has a span in the text; these create or remove the span itself.
//
// Same rule as fmlEdit: surgery, never a re-print. Each op touches only the
// lines it has to, inside one `@doc`, so comments, blank-line grouping and
// hand formatting everywhere else survive byte for byte. New lines are
// appended — to the end of `@nodes`, to the source's existing group in
// `@flow`, or the end of `@flow` — which is the simplest placement that is
// always correct; revisit only if it reads badly in practice.
//
// Every op returns the source unchanged when it can't apply (an id that's
// taken, a node or edge that isn't there), so callers can compare to detect a
// no-op instead of handling errors. The scanner reads lines exactly the way
// the parser lexes them — comments stripped, indentation-scoped groups, note
// blocks skipped — so an edit never lands on a line the parser reads
// differently.

import { docSpan } from "./fmlEdit.ts";

/** A node id or type: the parser's `[A-Za-z0-9_]+`. */
export const ID_RE = /^[A-Za-z0-9_]+$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

/** `#` is a comment at column 0 or after whitespace — the parser's rule. */
function codeOf(raw: string): { code: string; comment: string } {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
      return { code: raw.slice(0, i), comment: raw.slice(i) };
    }
  }
  return { code: raw, comment: "" };
}

const indentOf = (s: string): number => s.length - s.trimStart().length;
const cleanLabel = (raw: string): string => raw.replace(/^[-\s]+|[-\s]+$/g, "");

const RE = {
  header: /^\s*@/,
  nodes: /^\s*@nodes\s*$/,
  flow: /^\s*@flow\s*$/,
  nodeBlock: /^(\s*@node\s+)([A-Za-z0-9_]+)(\s*\{\s*)$/,
  decl: /^(\s*)([A-Za-z0-9_]+)(\s*=\s*)([A-Za-z0-9_]+)(\s*)$/,
  groupOpen: /^(\s*)([A-Za-z0-9_]+)(\s*:\s*)$/,
  groupEdge: /^(\s*-([^>\n]*)>\s*)([A-Za-z0-9_]+)(\s*\{)?(\s*)$/,
  inlineEdge: /^(\s*)([A-Za-z0-9_]+)(\s*-([^>\n]*)>\s*)([A-Za-z0-9_]+)(\s*\{)?(\s*)$/,
} as const;

interface FlowEdgeLine {
  /** First line of the edge. */
  index: number;
  /** Last line it owns — its note block's `}` when it has one. */
  last: number;
  source: string;
  target: string;
  label: string;
  /** The group it sits in; undefined for an inline edge. */
  group?: FlowGroup;
}

interface FlowGroup {
  /** The `<id>:` header line. */
  index: number;
  id: string;
  indent: number;
  edges: FlowEdgeLine[];
}

interface DocScan {
  start: number;
  end: number;
  /** `@nodes` header lines, in order. */
  nodesHeaders: number[];
  /** Every `<id> = <type>` line. */
  decls: Array<{ index: number; id: string; section: number }>;
  /** `@node <id> {` … `}` spans. */
  blocks: Array<{ id: string; index: number; last: number }>;
  /** `@flow` header lines, and the last line each section's content reaches. */
  flows: Array<{ index: number; last: number }>;
  edges: FlowEdgeLine[];
  groups: FlowGroup[];
  /** Index of the first section header of any kind. */
  firstHeader: number;
}

/**
 * The end of a note block opened on `openAt`: its `}` line, or — for a block
 * the author never closed — the last line still indented inside it. Matches
 * the parser's consumeEdgeNote.
 */
function noteEnd(lines: string[], openAt: number, end: number): number {
  const openIndent = indentOf(lines[openAt]!);
  let last = openAt;
  for (let i = openAt + 1; i < end; i++) {
    const code = codeOf(lines[i]!).code;
    if (code.trim() === "") continue;
    if (code.trim() === "}") return i;
    if (indentOf(code) <= openIndent) return last;
    last = i;
  }
  return last;
}

function scanDoc(lines: string[], docName: string): DocScan {
  const { start, end } = docSpan(lines, docName);
  const scan: DocScan = {
    start,
    end,
    nodesHeaders: [],
    decls: [],
    blocks: [],
    flows: [],
    edges: [],
    groups: [],
    firstHeader: -1,
  };

  let section: "nodes" | "flow" | "block" | "other" = "other";
  let group: FlowGroup | null = null;

  for (let i = start; i < end; i++) {
    const code = codeOf(lines[i]!).code.replace(/\s+$/, "");
    if (code.trim() === "") continue;

    if (RE.header.test(code)) {
      if (scan.firstHeader === -1) scan.firstHeader = i;
      group = null;
      const block = RE.nodeBlock.exec(code);
      if (block) {
        let last = i;
        for (let j = i + 1; j < end; j++) {
          last = j;
          if (codeOf(lines[j]!).code.trim() === "}") break;
        }
        scan.blocks.push({ id: block[2]!, index: i, last });
        i = last;
        section = "block";
        continue;
      }
      if (RE.nodes.test(code)) {
        section = "nodes";
        scan.nodesHeaders.push(i);
      } else if (RE.flow.test(code)) {
        section = "flow";
        scan.flows.push({ index: i, last: i });
      } else {
        section = "other";
      }
      continue;
    }

    if (section === "nodes") {
      const m = RE.decl.exec(code);
      if (m) scan.decls.push({ index: i, id: m[2]!, section: scan.nodesHeaders.length - 1 });
      continue;
    }
    if (section !== "flow") continue;

    const flow = scan.flows[scan.flows.length - 1]!;
    const indent = indentOf(code);
    if (group && indent <= group.indent) group = null;

    const g = RE.groupEdge.exec(code);
    if (g) {
      const last = g[4] !== undefined ? noteEnd(lines, i, end) : i;
      if (group) {
        const edge: FlowEdgeLine = { index: i, last, source: group.id, target: g[3]!, label: cleanLabel(g[2]!), group };
        group.edges.push(edge);
        scan.edges.push(edge);
      }
      flow.last = last;
      i = last;
      continue;
    }
    const inl = RE.inlineEdge.exec(code);
    if (inl) {
      group = null;
      const last = inl[6] !== undefined ? noteEnd(lines, i, end) : i;
      scan.edges.push({ index: i, last, source: inl[2]!, target: inl[5]!, label: cleanLabel(inl[4]!) });
      flow.last = last;
      i = last;
      continue;
    }
    const open = RE.groupOpen.exec(code);
    if (open) {
      group = { index: i, id: open[2]!, indent, edges: [] };
      scan.groups.push(group);
      flow.last = i;
    }
  }
  return scan;
}

/** Last line in [from, to) that isn't blank — where appended content should follow. */
function lastContent(lines: string[], from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (lines[i]!.trim() !== "") return i;
  return from - 1;
}

/** Leading whitespace of a line, verbatim. */
const lead = (s: string): string => s.slice(0, indentOf(s));

/**
 * Remove the given inclusive line ranges, bottom-up so indices stay valid,
 * then collapse any doubled blank line a removal left behind.
 */
function removeRanges(lines: string[], ranges: Array<[number, number]>): void {
  const sorted = [...ranges].sort((a, b) => b[0] - a[0]);
  for (const [from, to] of sorted) {
    lines.splice(from, to - from + 1);
    const before = lines[from - 1];
    const after = lines[from];
    if (before !== undefined && before.trim() === "" && (after === undefined || after.trim() === "")) {
      lines.splice(from - 1, 1);
    }
  }
}

/** Every node id the doc mentions — declared, block-only, or only drawn in `@flow`. */
function knownIds(scan: DocScan): Set<string> {
  const ids = new Set<string>();
  for (const d of scan.decls) ids.add(d.id);
  for (const b of scan.blocks) ids.add(b.id);
  for (const e of scan.edges) {
    ids.add(e.source);
    ids.add(e.target);
  }
  for (const g of scan.groups) ids.add(g.id);
  return ids;
}

/** `base1`, `base2`, … — the first id in that sequence the doc doesn't use. */
export function uniqueNodeId(src: string, docName: string, base: string): string {
  const taken = knownIds(scanDoc(src.split("\n"), docName));
  for (let n = 1; ; n++) {
    const id = `${base}${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Declare a new node: `<id> = <type>` at the end of `@nodes`, creating the
 * section (ahead of the first `@node`/`@flow`) when the doc has none. No
 * `@node { }` block — a bare declaration is a complete sketch.
 */
export function addNode(src: string, docName: string, id: string, type: string): string {
  if (!isValidId(id) || !isValidId(type)) return src;
  const lines = src.split("\n");
  const scan = scanDoc(lines, docName);
  if (knownIds(scan).has(id)) return src;

  const lastDecl = scan.decls[scan.decls.length - 1];
  if (lastDecl) {
    lines.splice(lastDecl.index + 1, 0, `${lead(lines[lastDecl.index]!)}${id} = ${type}`);
    return lines.join("\n");
  }
  const header = scan.nodesHeaders[scan.nodesHeaders.length - 1];
  if (header !== undefined) {
    lines.splice(header + 1, 0, `  ${id} = ${type}`);
    return lines.join("\n");
  }

  // No @nodes at all: open one before the first @node / @flow, or at the end.
  const firstBody = [...scan.blocks.map((b) => b.index), ...scan.flows.map((f) => f.index)].sort((a, b) => a - b)[0];
  if (firstBody !== undefined) {
    lines.splice(firstBody, 0, "@nodes", `  ${id} = ${type}`, "");
  } else {
    const at = lastContent(lines, scan.start, scan.end) + 1;
    lines.splice(at, 0, ...(at > 0 ? [""] : []), "@nodes", `  ${id} = ${type}`);
  }
  return lines.join("\n");
}

/**
 * Remove a node and everything that would dangle without it: its declaration,
 * its `@node` block, every edge into or out of it (note blocks included), and
 * a group it headed. A group left with no edges loses its header too.
 */
export function deleteNode(src: string, docName: string, id: string): string {
  const lines = src.split("\n");
  const scan = scanDoc(lines, docName);
  if (!knownIds(scan).has(id)) return src;

  const ranges: Array<[number, number]> = [];
  for (const d of scan.decls) if (d.id === id) ranges.push([d.index, d.index]);
  for (const b of scan.blocks) if (b.id === id) ranges.push([b.index, b.last]);

  const doomed = new Set(scan.edges.filter((e) => e.source === id || e.target === id));
  for (const e of doomed) ranges.push([e.index, e.last]);
  for (const g of scan.groups) {
    if (g.id === id || g.edges.every((e) => doomed.has(e))) ranges.push([g.index, g.index]);
  }

  removeRanges(lines, ranges);
  return lines.join("\n");
}

/**
 * Rename a node everywhere it's referenced in the doc — declaration, `@node`
 * header, and every flow line — rewriting only the id tokens, so an edge
 * label that happens to contain the old id is left alone, and so are comments.
 */
export function renameNode(src: string, docName: string, from: string, to: string): string {
  if (from === to || !isValidId(to)) return src;
  const lines = src.split("\n");
  const scan = scanDoc(lines, docName);
  const ids = knownIds(scan);
  if (!ids.has(from) || ids.has(to)) return src;

  const swap = (id: string): string => (id === from ? to : id);
  const rewrite = (i: number, re: RegExp, build: (m: RegExpExecArray) => string): void => {
    const { code, comment } = codeOf(lines[i]!);
    const m = re.exec(code.replace(/\s+$/, ""));
    if (!m) return;
    const trailing = code.slice(code.replace(/\s+$/, "").length);
    lines[i] = build(m) + trailing + comment;
  };

  for (const d of scan.decls) {
    if (d.id === from) rewrite(d.index, RE.decl, (m) => `${m[1]}${to}${m[3]}${m[4]}${m[5]}`);
  }
  for (const b of scan.blocks) {
    if (b.id === from) rewrite(b.index, RE.nodeBlock, (m) => `${m[1]}${to}${m[3]}`);
  }
  for (const g of scan.groups) {
    if (g.id === from) rewrite(g.index, RE.groupOpen, (m) => `${m[1]}${to}${m[3]}`);
  }
  for (const e of scan.edges) {
    if (e.source !== from && e.target !== from) continue;
    if (e.group) {
      rewrite(e.index, RE.groupEdge, (m) => `${m[1]}${swap(m[3]!)}${m[4] ?? ""}${m[5]}`);
    } else {
      rewrite(e.index, RE.inlineEdge, (m) => `${m[1]}${swap(m[2]!)}${m[3]}${swap(m[5]!)}${m[6] ?? ""}${m[7]}`);
    }
  }
  return lines.join("\n");
}

/** A label as it can be written between `-` and `>`: one line, no `>`. */
export function safeLabel(label: string): string {
  return label.replace(/[>\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

const arrow = (label: string): string => (label === "" ? "->" : `-${label}>`);

/**
 * Draw a new edge. When the source already heads a group in `@flow`, the edge
 * joins that group (that's where a reader looks for it); otherwise it's an
 * inline line at the end of `@flow`, which is created if the doc has none.
 * Duplicates are allowed — the parser keeps them as distinct edges.
 */
export function addEdge(
  src: string,
  docName: string,
  edge: { source: string; target: string; label: string },
): string {
  if (!isValidId(edge.source) || !isValidId(edge.target)) return src;
  const label = safeLabel(edge.label);
  const lines = src.split("\n");
  const scan = scanDoc(lines, docName);

  const group = [...scan.groups].reverse().find((g) => g.id === edge.source);
  if (group) {
    const tail = group.edges[group.edges.length - 1];
    const at = tail ? tail.last + 1 : group.index + 1;
    const indent = tail ? lead(lines[tail.index]!) : `${lead(lines[group.index]!)}  `;
    lines.splice(at, 0, `${indent}${arrow(label)} ${edge.target}`);
    return lines.join("\n");
  }

  const flow = scan.flows[scan.flows.length - 1];
  if (flow) {
    const sample = scan.edges.find((e) => !e.group) ?? scan.edges[0];
    const indent = sample ? lead(lines[sample.index]!) : "  ";
    const at = Math.max(flow.last, flow.index) + 1;
    lines.splice(at, 0, `${indent}${edge.source} ${arrow(label)} ${edge.target}`);
    return lines.join("\n");
  }

  const at = lastContent(lines, scan.start, scan.end) + 1;
  lines.splice(at, 0, ...(at > 0 ? [""] : []), "@flow", `  ${edge.source} ${arrow(label)} ${edge.target}`);
  return lines.join("\n");
}

/**
 * Remove one edge — the first flow line matching source, target and label —
 * with its note block. A group it leaves empty loses its header.
 */
export function deleteEdge(
  src: string,
  docName: string,
  edge: { source: string; target: string; label: string },
): string {
  const lines = src.split("\n");
  const scan = scanDoc(lines, docName);
  const hit = scan.edges.find((e) => e.source === edge.source && e.target === edge.target && e.label === edge.label);
  if (!hit) return src;
  const ranges: Array<[number, number]> = [[hit.index, hit.last]];
  if (hit.group && hit.group.edges.length === 1) ranges.push([hit.group.index, hit.group.index]);
  removeRanges(lines, ranges);
  return lines.join("\n");
}
