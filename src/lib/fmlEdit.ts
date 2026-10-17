// Targeted text edits back into `.fml` source. Each function changes one thing
// (a node's block, a node's type, an edge's label) inside one `@doc` and leaves
// the rest of the file — comments, other nodes, formatting — untouched.

const DOC_HEADER = /^@doc\s+([A-Za-z0-9_]+)\s*$/;
const NODES_HEADER = /^\s*@nodes\s*$/;
const cleanLabel = (raw: string) => raw.replace(/^[-\s]+|[-\s]+$/g, "");

/** Line range [start, end) holding one doc's body. */
export function docSpan(lines: string[], docName: string): { start: number; end: number } {
  const headers: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DOC_HEADER.exec(lines[i]!);
    if (m) headers.push({ name: m[1]!, line: i });
  }
  if (headers.length === 0) return { start: 0, end: lines.length };

  const idx = headers.findIndex((h) => h.name === docName);
  if (idx === -1) {
    return docName === "main"
      ? { start: 0, end: headers[0]!.line }
      : { start: 0, end: lines.length };
  }
  return {
    start: headers[idx]!.line + 1,
    end: idx + 1 < headers.length ? headers[idx + 1]!.line : lines.length,
  };
}

/** Where to drop a new `@node` block inside a doc. */
function nodeBlockInsertPoint(lines: string[], start: number, end: number): number {
  let lastClose = -1;
  let inNode = false;
  for (let i = start; i < end; i++) {
    if (/^\s*@node\s+[A-Za-z0-9_]+\s*\{\s*$/.test(lines[i]!)) inNode = true;
    else if (inNode && lines[i]!.trim() === "}") {
      lastClose = i;
      inNode = false;
    }
  }
  if (lastClose !== -1) return lastClose + 1;

  let nodesAt = -1;
  for (let i = start; i < end; i++) {
    if (NODES_HEADER.test(lines[i]!)) {
      nodesAt = i;
      break;
    }
  }
  if (nodesAt !== -1) {
    let last = nodesAt;
    for (let i = nodesAt + 1; i < end; i++) {
      if (/^@/.test(lines[i]!)) break;
      if (lines[i]!.trim() !== "") last = i;
    }
    return last + 1;
  }
  return end;
}

/**
 * Replace / insert / remove the `@node <id> { … }` block for one node.
 * `data` carries every key the block should have (`label` included); keys with
 * an empty value are dropped, and an empty `data` removes the block entirely.
 */
export function setNodeBlock(
  src: string,
  docName: string,
  nodeId: string,
  data: Record<string, string>,
): string {
  const lines = src.split("\n");
  const { start, end } = docSpan(lines, docName);
  const headerRe = new RegExp(`^\\s*@node\\s+${nodeId}\\s*\\{\\s*$`);

  let blkStart = -1;
  let blkEnd = -1;
  for (let i = start; i < end; i++) {
    if (!headerRe.test(lines[i]!)) continue;
    blkStart = i;
    for (let j = i + 1; j < end; j++) {
      if (lines[j]!.trim() === "}") {
        blkEnd = j;
        break;
      }
    }
    break;
  }

  const entries = Object.entries(data).filter(([k, v]) => k.trim() !== "" && v.trim() !== "");
  const block =
    entries.length > 0
      ? [`@node ${nodeId} {`, ...entries.map(([k, v]) => `  ${k}: ${v}`), "}"]
      : null;

  if (blkStart !== -1 && blkEnd !== -1) {
    if (block) lines.splice(blkStart, blkEnd - blkStart + 1, ...block);
    else lines.splice(blkStart, blkEnd - blkStart + 1);
  } else if (block) {
    const at = nodeBlockInsertPoint(lines, start, end);
    const prevBlank = at > 0 && lines[at - 1]!.trim() === "";
    lines.splice(at, 0, ...(prevBlank ? block : ["", ...block]));
  }
  return lines.join("\n");
}

/**
 * The literal source for one node: its `@nodes` declaration line, then a blank
 * line, then its `@node { … }` block (verbatim, if it has one). This is what the
 * property panel's Code tab shows for direct editing / copying.
 */
export function nodeSource(src: string, docName: string, nodeId: string): string {
  const lines = src.split("\n");
  const { start, end } = docSpan(lines, docName);
  const out: string[] = [];

  const declRe = new RegExp(`^\\s*${nodeId}\\s*=\\s*[A-Za-z0-9_]+\\s*$`);
  for (let i = start; i < end; i++) {
    if (declRe.test(lines[i]!)) {
      out.push(lines[i]!.trim());
      break;
    }
  }

  const headRe = new RegExp(`^\\s*@node\\s+${nodeId}\\s*\\{\\s*$`);
  for (let i = start; i < end; i++) {
    if (!headRe.test(lines[i]!)) continue;
    if (out.length) out.push("");
    for (let j = i; j < end; j++) {
      out.push(lines[j]!);
      if (lines[j]!.trim() === "}") break;
    }
    break;
  }
  return out.join("\n");
}

/**
 * Write an edited Code-tab block back. `text` is parsed for a `<id> = <type>`
 * line and/or a `@node <id> { … }` body; the type and the block are then applied
 * through the same targeted edits as the form. Comments typed inside the block
 * are not preserved (the block is regenerated), everything else in the file is.
 */
export function setNodeSource(
  src: string,
  docName: string,
  nodeId: string,
  text: string,
): string {
  const declRe = new RegExp(`^\\s*${nodeId}\\s*=\\s*([A-Za-z0-9_]+)\\s*$`);
  const headRe = new RegExp(`^\\s*@node\\s+${nodeId}\\s*\\{\\s*$`);
  const kvRe = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

  let newType: string | null = null;
  const data: Record<string, string> = {};
  let inBlock = false;

  for (const l of text.split("\n")) {
    if (!inBlock) {
      const dm = declRe.exec(l);
      if (dm) {
        newType = dm[1]!;
        continue;
      }
    }
    if (headRe.test(l)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (l.trim() === "}") {
        inBlock = false;
        continue;
      }
      if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
      const km = kvRe.exec(l);
      if (km) data[km[1]!] = km[2]!;
    }
  }

  let out = src;
  if (newType) out = setNodeType(out, docName, nodeId, newType);
  return setNodeBlock(out, docName, nodeId, data);
}

/** Change a node's type on its `@nodes` declaration line. */
export function setNodeType(
  src: string,
  docName: string,
  nodeId: string,
  type: string,
): string {
  const lines = src.split("\n");
  const { start, end } = docSpan(lines, docName);
  const re = new RegExp(`^(\\s*)(${nodeId})\\s*=\\s*[A-Za-z0-9_]+\\s*$`);
  for (let i = start; i < end; i++) {
    const m = re.exec(lines[i]!);
    if (m) {
      lines[i] = `${m[1]}${m[2]} = ${type}`;
      break;
    }
  }
  return lines.join("\n");
}

const GROUP_OPEN = /^(\s*)([A-Za-z0-9_]+)\s*:\s*$/;
const INLINE_EDGE = /^(\s*)([A-Za-z0-9_]+)\s*-([^>\n]*)>\s*([A-Za-z0-9_]+)(\s*\{)?\s*$/;
const GROUP_EDGE = /^(\s*)-([^>\n]*)>\s*([A-Za-z0-9_]+)(\s*\{)?\s*$/;

/** Where one edge is written, and whether it already carries a note block. */
interface EdgeLine {
  /** Index of the flow line. */
  index: number;
  /** Leading whitespace of that line. */
  indent: string;
  /** The line rebuilt from `label`, without a trailing `{`. */
  render: (label: string) => string;
  /** A `{ … }` note block opens on this line. */
  open: boolean;
  /** Index of the block's closing `}`; -1 when there is no block. */
  close: number;
  /** A trailing `# comment` on the line (with the space before it), kept on rewrite. */
  comment: string;
}

/** Split a line at its comment — `#` at column 0 or after whitespace, as the parser lexes it. */
function splitComment(raw: string): { code: string; comment: string } {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
      const code = raw.slice(0, i);
      const kept = code.replace(/\s+$/, "");
      return { code: kept, comment: raw.slice(kept.length) };
    }
  }
  return { code: raw, comment: "" };
}

/** Index of the `}` closing a note block opened on `openAt`, or -1. */
function noteBlockClose(lines: string[], openAt: number, end: number): number {
  const indent = lines[openAt]!.length - lines[openAt]!.trimStart().length;
  for (let i = openAt + 1; i < end; i++) {
    const t = lines[i]!.trim();
    if (t === "}") return i;
    if (t !== "" && lines[i]!.length - lines[i]!.trimStart().length <= indent) return -1;
  }
  return -1;
}

/**
 * Locate the first flow line matching this edge. Note-block bodies are skipped
 * so a `key:` inside a note can never be mistaken for a group header.
 */
function findEdgeLine(
  lines: string[],
  start: number,
  end: number,
  edge: { source: string; target: string; label: string },
): EdgeLine | null {
  let group: string | null = null;

  for (let i = start; i < end; i++) {
    // Match the code, not the comment — `A -x> B   # why` is still an edge.
    const { code: line, comment } = splitComment(lines[i]!);

    const inl = INLINE_EDGE.exec(line);
    const grp = inl ? null : GROUP_EDGE.exec(line);

    if (inl || grp) {
      const indent = (inl ? inl[1] : grp![1])!;
      const src = inl ? inl[2]! : group;
      const rawLabel = (inl ? inl[3] : grp![2])!;
      const tgt = (inl ? inl[4] : grp![3])!;
      const open = (inl ? inl[5] : grp![4]) !== undefined;
      if (inl) group = null;

      const close = open ? noteBlockClose(lines, i, end) : -1;

      if (src === edge.source && tgt === edge.target && cleanLabel(rawLabel) === edge.label) {
        const seg = (label: string) => (label.trim() === "" ? "->" : `-${label.trim()}>`);
        return {
          index: i,
          indent,
          render: (label) =>
            inl ? `${indent}${inl[2]} ${seg(label)} ${tgt}` : `${indent}${seg(label)} ${tgt}`,
          open,
          close,
          comment,
        };
      }

      // Not our edge — jump past its note block so we don't walk into it.
      if (close !== -1) i = close;
      continue;
    }

    const gOpen = GROUP_OPEN.exec(line);
    if (gOpen) {
      group = gOpen[2]!;
      continue;
    }

    if (/^@/.test(line)) group = null;
  }
  return null;
}

/** Rewrite the label on the first flow line that matches this edge. */
export function setEdgeLabel(
  src: string,
  docName: string,
  edge: { source: string; target: string; label: string },
  newLabel: string,
): string {
  const lines = src.split("\n");
  const { start, end } = docSpan(lines, docName);
  const hit = findEdgeLine(lines, start, end, edge);
  if (!hit) return src;
  lines[hit.index] = `${hit.render(newLabel)}${hit.open ? " {" : ""}${hit.comment}`;
  return lines.join("\n");
}

/**
 * Replace / add / remove the `{ … }` note block on an edge.
 * An empty `data` (or one whose values are all blank) removes the block and the
 * `{` that opened it; anything else regenerates the body in place.
 */
export function setEdgeNote(
  src: string,
  docName: string,
  edge: { source: string; target: string; label: string },
  data: Record<string, string>,
): string {
  const lines = src.split("\n");
  const { start, end } = docSpan(lines, docName);
  const hit = findEdgeLine(lines, start, end, edge);
  if (!hit) return src;

  const entries = Object.entries(data).filter(([k, v]) => k.trim() !== "" && v.trim() !== "");
  const body = entries.map(([k, v]) => `${hit.indent}  ${k}: ${v}`);
  const head = hit.render(edge.label);

  // Everything currently occupied by the edge line plus its block.
  const span = hit.open && hit.close !== -1 ? hit.close - hit.index + 1 : 1;

  const replacement =
    entries.length > 0 ? [`${head} {${hit.comment}`, ...body, `${hit.indent}}`] : [`${head}${hit.comment}`];

  lines.splice(hit.index, span, ...replacement);
  return lines.join("\n");
}
