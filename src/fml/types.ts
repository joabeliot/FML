// FML — Flowchart Markup Language
// v0.1 type definitions

/** Node type is an opaque string in v0.1 (e.g. "page", "api", "decision"). */
export type FmlNodeType = string;

export interface FmlNode {
  id: string;
  type: FmlNodeType;
  /** Free-form metadata from `@node <id> { ... }` blocks. */
  data: Record<string, string>;
}

export interface FmlEdge {
  /** `edge_<source>_<target>`, with a `_<n>` suffix when the pair repeats. */
  id: string;
  source: string;
  target: string;
  /** Everything between `-` and `>` on the flow line, trimmed. May be "". */
  label: string;
  /**
   * Free-form `key: value` pairs from a trailing `{ … }` note block on the
   * edge line (same rules as an `@node` body). Absent when the edge has no
   * block, so edges without notes serialise exactly as before.
   */
  data?: Record<string, string>;
}

export interface FmlDoc {
  /** From `@doc <name>` / `@fof … as <name>`; `"main"` for the root file's body. */
  name: string;
  /** The `@fof` path this doc was pulled from; absent for the root file's own docs. */
  source?: string;
  meta: Record<string, string>;
  /**
   * `@vars` — default values for `{name}` interpolation. A variable used in a
   * node's data but never declared here (and never `capture`d by an earlier
   * node) is a run-time input: nothing to resolve yet, the future runner will
   * have to ask for it. See `variables.ts`.
   */
  vars: Record<string, string>;
  nodes: FmlNode[];
  edges: FmlEdge[];
}

export interface FmlFile {
  /** One entry per `@doc` block or resolved `@fof`. Always at least one. */
  docs: FmlDoc[];
}

export interface FmlIssue {
  /** 1-based source line. */
  line: number;
  message: string;
  /** `@fof` path of the file this issue is in; absent for the root file. */
  file?: string;
}

/**
 * The node-type standard a parse checks against. FML's own (`nodeTypes.ts`)
 * is the default; a sibling language on the same grammar — RML — passes its
 * own, so the line grammar, comments, @doc and @fof are shared, not copied.
 */
export interface FmlVocabulary {
  /** The standard type names, for messages. */
  names: readonly string[];
  isKnown(type: string): boolean;
  /** Expected keys a node of this type is missing (strict-mode hints). */
  missing(type: string, data: Record<string, string>): string[];
}

export interface ParseOptions {
  /** Node-type standard to check against. Defaults to FML's. */
  vocabulary?: FmlVocabulary;
  /**
   * true (default): a flow reference to an undeclared node is an error.
   * false: the node is auto-created with type "unknown" and a warning.
   */
  strict?: boolean;
  /**
   * Resolve an `@fof <path>` to that file's text. `from` is the path of the
   * file containing the `@fof` (`undefined` for the root), for relative
   * resolution. Return `undefined` if it can't be found. Paths are written
   * without the `.fml` extension. With no resolver, `@fof` lines are skipped
   * with a warning.
   */
  resolve?: (path: string, from: string | undefined) => string | undefined;
}

export interface ParseResult {
  ok: boolean;
  /** The whole file — every `@doc`. */
  file: FmlFile;
  /** Convenience alias for `file.docs[0]`; what single-diagram callers want. */
  doc: FmlDoc;
  errors: FmlIssue[];
  warnings: FmlIssue[];
}
