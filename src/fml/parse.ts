// FML — Flowchart Markup Language
// v0.2 parser. Line-oriented, hand-written, zero dependencies.
//
// Grammar (informal):
//
//   file      := doc*
//   doc       := "@doc" NAME NL section*        # NAME optional overall — no @doc ⇒ one "main" doc
//   section   := "@meta" NL kv*
//              | "@vars" NL kv*                    # defaults for {name} interpolation
//              | "@nodes" NL decl*
//              | "@node" ID "{" NL kv* "}"
//              | "@flow" NL flowline*
//   decl      := ID "=" ID                     # <id> = <type>
//   kv        := KEY ":" REST                   # everything after first ":" is the value
//   flowline  := ID ":"                         # opens a group; source for the lines below
//              | "-" LABEL ">" ID               # edge from the current group
//              | ID "-" LABEL ">" ID            # inline edge
//
// Rules:
//   * IDs are [A-Za-z0-9_] only (so `-` is unambiguously the arrow).
//   * `#` starts a comment at line start or after whitespace.
//   * Blank lines are ignored. Section order does not matter.
//   * `-->` / `-  ->` normalise to an empty label; `-200,202>` is one edge labelled "200,202".
//   * Node ids are doc-local: the same id in two @docs is two independent nodes.
//   * Node types come from the standard vocabulary in `nodeTypes.ts`. Anything
//     else parses and draws, but warns (errors in strict). Strict mode also
//     warns about a standard type missing its expected keys.

import type {
  FmlDoc,
  FmlEdge,
  FmlIssue,
  FmlNode,
  FmlVocabulary,
  ParseOptions,
  ParseResult,
} from "./types.ts";
import { NODE_TYPE_NAMES, UNTYPED, isKnownType, missingKeys } from "./nodeTypes.ts";

/** FML's own node-type standard — the default vocabulary. */
export const FML_VOCABULARY: FmlVocabulary = {
  names: NODE_TYPE_NAMES,
  isKnown: isKnownType,
  missing: missingKeys,
};

interface Line {
  /** 1-based source line number. */
  n: number;
  /** Leading-whitespace count (chars). */
  indent: number;
  /** Comment-stripped, trimmed content. */
  text: string;
}

type SectionKind = "meta" | "vars" | "nodes" | "node" | "flow";

interface Section {
  kind: SectionKind;
  /** Present only for `kind === "node"`. */
  nodeId?: string;
  header: Line;
  body: Line[];
}

const RE = {
  docHeader: /^@doc\s+([A-Za-z0-9_]+)\s*$/,
  // @fof <path> [as <name>] — path has no extension (it's always .fml).
  fofHeader: /^@fof\s+(\S.*?)(?:\s+as\s+([A-Za-z0-9_]+))?\s*$/,
  nodeHeader: /^@node\s+([A-Za-z0-9_]+)\s*\{$/,
  section: /^@(meta|vars|nodes|flow)$/,
  decl: /^([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_]+)$/,
  // `.` is allowed so repeatable execution keys work: `header.Authorization`,
  // `query.page`, `capture.token`.
  kv: /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/,
  groupOpen: /^([A-Za-z0-9_]+)\s*:$/,
  // Trailing `(\s*\{)?` captures a note-block opener on the same line as the arrow.
  groupEdge: /^-([^>\n]*)>\s*([A-Za-z0-9_]+)(\s*\{)?$/,
  inlineEdge: /^([A-Za-z0-9_]+)\s*-([^>\n]*)>\s*([A-Za-z0-9_]+)(\s*\{)?$/,
} as const;

/** `#` is a comment at column 0 or when preceded by whitespace. */
function stripComment(raw: string): string {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function lex(src: string): Line[] {
  const out: Line[] = [];
  const raw = src.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const stripped = stripComment(raw[i]!).replace(/\s+$/, "");
    if (stripped.trim() === "") continue;
    out.push({
      n: i + 1,
      indent: stripped.length - stripped.trimStart().length,
      text: stripped.trim(),
    });
  }
  return out;
}

interface DocChunk {
  name: string;
  lines: Line[];
}

interface FofRef {
  /** Path as written, e.g. "./screens/auth" (no extension). */
  path: string;
  /** Import name — `as <name>`, or the last path segment. */
  name: string;
  line: number;
}

/** Last path segment, `.fml` stripped, sanitised to a valid name. */
function nameFromPath(path: string): string {
  const seg = path.split(/[/\\]/).pop() ?? path;
  return seg.replace(/\.fml$/i, "").replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Split the line stream into per-`@doc` chunks plus the file's `@fof` imports.
 * Lines before the first `@doc` (or the whole file, if there is no `@doc`) go to
 * an implicit `"main"` doc. A repeated `@doc <name>` merges with a warning; a
 * malformed `@doc` / `@fof` line is an error and is skipped.
 */
function splitFile(
  lines: Line[],
  errors: FmlIssue[],
  warnings: FmlIssue[],
): { chunks: DocChunk[]; fofs: FofRef[] } {
  const chunks: DocChunk[] = [];
  const fofs: FofRef[] = [];
  let cur: DocChunk | null = null;

  for (const line of lines) {
    if (line.indent === 0 && /^@fof(\s|$)/.test(line.text)) {
      const m = RE.fofHeader.exec(line.text);
      if (!m) {
        errors.push({
          line: line.n,
          message: `@fof needs "@fof <path> [as <name>]", got "${line.text}"`,
        });
        continue;
      }
      const path = m[1]!.trim();
      const name = m[2] ?? nameFromPath(path);
      if (!name) {
        errors.push({ line: line.n, message: `@fof "${path}" — add "as <name>"` });
        continue;
      }
      fofs.push({ path, name, line: line.n });
      continue;
    }

    if (line.indent === 0 && /^@doc(\s|$)/.test(line.text)) {
      const m = RE.docHeader.exec(line.text);
      if (!m) {
        errors.push({
          line: line.n,
          message: `@doc needs a name matching [A-Za-z0-9_], got "${line.text}"`,
        });
        continue;
      }
      const name = m[1]!;
      const existing = chunks.find((c) => c.name === name);
      if (existing) {
        warnings.push({ line: line.n, message: `@doc "${name}" repeated — merging` });
        cur = existing;
      } else {
        cur = { name, lines: [] };
        chunks.push(cur);
      }
      continue;
    }

    if (!cur) {
      cur = chunks.find((c) => c.name === "main") ?? null;
      if (!cur) {
        cur = { name: "main", lines: [] };
        chunks.push(cur);
      }
    }
    cur.lines.push(line);
  }

  if (chunks.length === 0 && fofs.length === 0) chunks.push({ name: "main", lines: [] });
  return { chunks, fofs };
}

function sectionize(lines: Line[], errors: FmlIssue[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;

  for (const line of lines) {
    if (line.indent === 0 && line.text.startsWith("@")) {
      if (cur) sections.push(cur);
      cur = null;

      const node = RE.nodeHeader.exec(line.text);
      if (node) {
        cur = { kind: "node", nodeId: node[1]!, header: line, body: [] };
        continue;
      }
      const sec = RE.section.exec(line.text);
      if (sec) {
        cur = { kind: sec[1] as SectionKind, header: line, body: [] };
        continue;
      }
      errors.push({
        line: line.n,
        message: `unknown directive: "${line.text.split(/\s/)[0]}"`,
      });
      continue;
    }

    if (!cur) {
      errors.push({
        line: line.n,
        message: `content outside any @section: "${line.text}"`,
      });
      continue;
    }

    if (cur.kind === "node" && line.text === "}") {
      sections.push(cur);
      cur = null;
      continue;
    }

    cur.body.push(line);
  }

  if (cur) {
    if (cur.kind === "node") {
      errors.push({
        line: cur.header.n,
        message: `@node ${cur.nodeId} block is missing a closing "}"`,
      });
    }
    sections.push(cur);
  }

  return sections;
}

function parseKv(body: Line[], issues: FmlIssue[]): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const l of body) {
    const m = RE.kv.exec(l.text);
    if (!m) {
      issues.push({ line: l.n, message: `expected "key: value", got "${l.text}"` });
      continue;
    }
    rec[m[1]!] = m[2]!.trim();
  }
  return rec;
}

/** Strip surrounding dashes/whitespace so `-->` and `- x ->` behave. */
function cleanLabel(raw: string): string {
  return raw.replace(/^[-\s]+|[-\s]+$/g, "");
}

/**
 * Consume a `{ … }` note block that opened at the end of an edge line.
 * `start` is the index of the first body line after the edge line; `openIndent`
 * is the edge line's indent. Body lines (indent > openIndent) are read as
 * `key: value` and assigned into `edge.data`; the block ends at a lone `}`.
 *
 * Returns the body index the outer loop should treat as consumed — the caller
 * does `i = <return>` so its own `i++` resumes on the next real line:
 *   - closed block  → index of the `}` line (skipped)
 *   - unclosed block → index just before the dedented / trailing line, so that
 *     line is still processed as a normal flow line (never swallowed)
 */
function consumeEdgeNote(
  body: Line[],
  start: number,
  openIndent: number,
  edge: FmlEdge,
  errors: FmlIssue[],
): number {
  const data: Record<string, string> = {};
  let i = start;
  for (; i < body.length; i++) {
    const l = body[i]!;
    if (l.text === "}") {
      if (Object.keys(data).length > 0) edge.data = data;
      return i;
    }
    if (l.indent <= openIndent) break; // dedented out of the block, no `}` seen
    const m = RE.kv.exec(l.text);
    if (m) {
      data[m[1]!] = m[2]!.trim();
    } else {
      errors.push({ line: l.n, message: `expected "key: value" in edge note, got "${l.text}"` });
    }
  }
  errors.push({
    line: body[start - 1]!.n,
    message: `edge note block for "${edge.source} -> ${edge.target}" is missing a closing "}"`,
  });
  if (Object.keys(data).length > 0) edge.data = data;
  return i - 1;
}

function parseDoc(
  name: string,
  lines: Line[],
  strict: boolean,
  errors: FmlIssue[],
  warnings: FmlIssue[],
  vocab: FmlVocabulary,
): FmlDoc {
  const sections = sectionize(lines, errors);

  const meta: Record<string, string> = {};
  const vars: Record<string, string> = {};
  const table = new Map<string, FmlNode>();
  const edges: FmlEdge[] = [];
  const pairCount = new Map<string, number>();

  const refNode = (id: string, line: number): void => {
    if (table.has(id)) return;
    if (strict) {
      errors.push({
        line,
        message: `flow references undeclared node "${id}" — add it to @nodes`,
      });
    } else {
      warnings.push({ line, message: `auto-created undeclared node "${id}"` });
    }
    table.set(id, { id, type: UNTYPED, data: {} });
  };

  const addEdge = (source: string, target: string, label: string, line: number): FmlEdge => {
    refNode(source, line);
    refNode(target, line);
    const base = `edge_${source}_${target}`;
    const seen = pairCount.get(base) ?? 0;
    pairCount.set(base, seen + 1);
    const edge: FmlEdge = { id: seen === 0 ? base : `${base}_${seen}`, source, target, label };
    edges.push(edge);
    return edge;
  };

  // Pass 1: @meta, @vars
  for (const s of sections) {
    if (s.kind === "meta") Object.assign(meta, parseKv(s.body, errors));
    if (s.kind === "vars") Object.assign(vars, parseKv(s.body, errors));
  }

  // Pass 2: @nodes (roster)
  // declLine remembers where each node was declared, so type/key diagnostics
  // raised after the metadata pass can still point at a real line.
  const declLine = new Map<string, number>();
  for (const s of sections) {
    if (s.kind !== "nodes") continue;
    for (const l of s.body) {
      const m = RE.decl.exec(l.text);
      if (!m) {
        errors.push({ line: l.n, message: `expected "<id> = <type>", got "${l.text}"` });
        continue;
      }
      const [, id, type] = m as unknown as [string, string, string];
      if (table.has(id)) {
        warnings.push({ line: l.n, message: `node "${id}" redeclared` });
      }
      if (!vocab.isKnown(type)) {
        const message =
          `unknown node type "${type}" for "${id}" — ` +
          `the standard types are ${vocab.names.join(", ")}`;
        (strict ? errors : warnings).push({ line: l.n, message });
      }
      declLine.set(id, l.n);
      table.set(id, { id, type, data: table.get(id)?.data ?? {} });
    }
  }

  // Pass 3: @node <id> { ... } (metadata)
  for (const s of sections) {
    if (s.kind !== "node" || !s.nodeId) continue;
    const existing = table.get(s.nodeId);
    if (!existing) {
      if (strict) {
        errors.push({
          line: s.header.n,
          message: `@node "${s.nodeId}" has no matching entry in @nodes`,
        });
      } else {
        warnings.push({
          line: s.header.n,
          message: `@node "${s.nodeId}" not in @nodes — created with type "${UNTYPED}"`,
        });
      }
      table.set(s.nodeId, { id: s.nodeId, type: UNTYPED, data: {} });
    }
    Object.assign(table.get(s.nodeId)!.data, parseKv(s.body, errors));
  }

  // Pass 3b: expected-key hints. Strict only — loose mode draws whatever you
  // gave it without nagging, which is what you want while you are still typing.
  if (strict) {
    for (const node of table.values()) {
      const missing = vocab.missing(node.type, node.data);
      if (missing.length === 0) continue;
      warnings.push({
        line: declLine.get(node.id) ?? 0,
        message: `${node.type} "${node.id}" is missing ${missing.map((k) => `"${k}"`).join(", ")}`,
      });
    }
  }

  // Pass 4: @flow
  for (const s of sections) {
    if (s.kind !== "flow") continue;
    let group: { id: string; indent: number } | null = null;

    // Index-based so a matched edge with a trailing `{` can consume the lines
    // of its note block before the loop resumes at the right place.
    for (let i = 0; i < s.body.length; i++) {
      const l = s.body[i]!;
      if (group && l.indent <= group.indent) group = null;

      const gEdge = RE.groupEdge.exec(l.text);
      if (gEdge) {
        if (!group) {
          errors.push({
            line: l.n,
            message: `edge "${l.text}" has no source group above it`,
          });
          continue;
        }
        const edge = addEdge(group.id, gEdge[2]!, cleanLabel(gEdge[1]!), l.n);
        if (gEdge[3] !== undefined) i = consumeEdgeNote(s.body, i + 1, l.indent, edge, errors);
        continue;
      }

      const iEdge = RE.inlineEdge.exec(l.text);
      if (iEdge) {
        group = null;
        const edge = addEdge(iEdge[1]!, iEdge[3]!, cleanLabel(iEdge[2]!), l.n);
        if (iEdge[4] !== undefined) i = consumeEdgeNote(s.body, i + 1, l.indent, edge, errors);
        continue;
      }

      const gOpen = RE.groupOpen.exec(l.text);
      if (gOpen) {
        group = { id: gOpen[1]!, indent: l.indent };
        refNode(gOpen[1]!, l.n);
        continue;
      }

      errors.push({ line: l.n, message: `unrecognised flow line: "${l.text}"` });
    }
  }

  return { name, meta, vars, nodes: [...table.values()], edges };
}

const MAX_FOF_DEPTH = 16;

interface FofCtx {
  strict: boolean;
  vocab: FmlVocabulary;
  resolve: ((path: string, from: string | undefined) => string | undefined) | undefined;
  errors: FmlIssue[];
  warnings: FmlIssue[];
  /** Resolution stack — paths currently being expanded, for cycle detection. */
  seen: Set<string>;
  depth: number;
}

/** Parse one file's text into docs, recursing into its `@fof` imports. */
function resolveFile(src: string, sourcePath: string | undefined, ctx: FofCtx): FmlDoc[] {
  const { errors, warnings } = ctx;
  const eStart = errors.length;
  const wStart = warnings.length;

  const { chunks, fofs } = splitFile(lex(src), errors, warnings);
  const localDocs = chunks.map((c) => parseDoc(c.name, c.lines, ctx.strict, errors, warnings, ctx.vocab));
  for (const d of localDocs) d.source = sourcePath;

  // Tag this file's own issues with its path, before recursion adds deeper ones.
  if (sourcePath !== undefined) {
    for (let i = eStart; i < errors.length; i++) errors[i]!.file ??= sourcePath;
    for (let i = wStart; i < warnings.length; i++) warnings[i]!.file ??= sourcePath;
  }

  const imported: FmlDoc[] = [];
  for (const fof of fofs) {
    if (!ctx.resolve) {
      warnings.push({ line: fof.line, message: `@fof "${fof.path}" skipped — no resolver`, file: sourcePath });
      continue;
    }
    if (ctx.depth >= MAX_FOF_DEPTH) {
      errors.push({ line: fof.line, message: `@fof nesting too deep at "${fof.path}"`, file: sourcePath });
      continue;
    }
    if (ctx.seen.has(fof.path)) {
      errors.push({ line: fof.line, message: `circular @fof "${fof.path}"`, file: sourcePath });
      continue;
    }
    const content = ctx.resolve(fof.path, sourcePath);
    if (content === undefined) {
      const issue: FmlIssue = { line: fof.line, message: `cannot resolve @fof "${fof.path}"`, file: sourcePath };
      (ctx.strict ? errors : warnings).push(issue);
      continue;
    }

    ctx.seen.add(fof.path);
    ctx.depth++;
    const sub = resolveFile(content, fof.path, ctx);
    ctx.depth--;
    ctx.seen.delete(fof.path);

    const own = sub.filter((d) => d.source === fof.path);
    const trans = sub.filter((d) => d.source !== fof.path);
    if (own.length > 1) {
      warnings.push({
        line: fof.line,
        message: `@fof "${fof.path}" has ${own.length} docs — using the first as "${fof.name}"`,
        file: sourcePath,
      });
    }
    if (own[0]) {
      own[0].name = fof.name;
      imported.push(own[0]);
    }
    imported.push(...trans);
  }

  return [...localDocs, ...imported];
}

/** Make doc names unique; a collision is renamed with a numeric suffix. */
function dedupeNames(docs: FmlDoc[], warnings: FmlIssue[]): void {
  const used = new Set<string>();
  for (const d of docs) {
    if (!used.has(d.name)) {
      used.add(d.name);
      continue;
    }
    let n = 2;
    while (used.has(`${d.name}_${n}`)) n++;
    warnings.push({
      line: 0,
      message: `duplicate doc name "${d.name}" — renamed to "${d.name}_${n}"`,
      file: d.source,
    });
    d.name = `${d.name}_${n}`;
    used.add(d.name);
  }
}

export function parse(src: string, opts: ParseOptions = {}): ParseResult {
  const errors: FmlIssue[] = [];
  const warnings: FmlIssue[] = [];
  const ctx: FofCtx = {
    strict: opts.strict !== false,
    vocab: opts.vocabulary ?? FML_VOCABULARY,
    resolve: opts.resolve,
    errors,
    warnings,
    seen: new Set(),
    depth: 0,
  };

  const docs = resolveFile(src, undefined, ctx);
  if (docs.length === 0) docs.push({ name: "main", meta: {}, vars: {}, nodes: [], edges: [] });
  dedupeNames(docs, warnings);

  return {
    ok: errors.length === 0,
    file: { docs },
    doc: docs[0]!,
    errors,
    warnings,
  };
}
