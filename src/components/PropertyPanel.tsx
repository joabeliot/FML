import { useEffect, useMemo, useState } from "react";
import {
  NODE_TYPES,
  UNTYPED,
  isKnownType,
  missingKeys,
  nodeTypeSpec,
  nodeVarUsage,
  resolveVariables,
  type FmlDoc,
  type FmlEdge,
  type FmlNode,
  type NodeVarUsage,
} from "../fml/index.ts";
import type { StepResult } from "../fml/index.ts";
import { kindColor } from "../lib/nodeStyle.ts";
import { Glyph } from "./Glyph.tsx";

export interface Selection {
  kind: "node" | "edge";
  id: string;
}

interface Props {
  sel: Selection;
  doc: FmlDoc;
  /** Panel width taken by the source editor, so this docks beside it. */
  shiftLeft: number;
  onClose: () => void;
  onCommitNode: (id: string, block: Record<string, string>, type: string) => void;
  onCommitEdgeLabel: (edge: FmlEdge, label: string) => void;
  onCommitEdgeNote: (edge: FmlEdge, data: Record<string, string>) => void;
  /** Literal FML for the selected node — decl line + `@node { }` block. */
  nodeCode: string;
  onCommitNodeCode: (id: string, text: string) => void;
  /** This node's result in the last run, when there was one. */
  runStep?: StepResult;
  /** Rename the selected node everywhere in its doc; false when the id is taken or invalid. */
  onRenameNode: (from: string, to: string) => boolean;
  /** Delete the selection from the source. Absent while a run is in flight. */
  onDelete?: () => void;
}

type Row = [string, string];

const field =
  "w-full rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none transition-colors placeholder:text-ink-mute focus:border-accent/60";
const keyLabel = "font-mono text-[10px] uppercase tracking-[0.08em] text-ink-mute";
const chip =
  "rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-dim transition-colors hover:border-line-strong hover:text-ink";

type PanelTab = "props" | "about" | "code" | "run";

export function PropertyPanel({
  sel,
  doc,
  shiftLeft,
  onClose,
  onCommitNode,
  onCommitEdgeLabel,
  onCommitEdgeNote,
  nodeCode,
  onCommitNodeCode,
  runStep,
  onRenameNode,
  onDelete,
}: Props) {
  const node = sel.kind === "node" ? doc.nodes.find((n) => n.id === sel.id) : undefined;
  const edge = sel.kind === "edge" ? doc.edges.find((e) => e.id === sel.id) : undefined;
  const accent = node ? kindColor(node.type) : "var(--color-accent)";

  const [tab, setTab] = useState<PanelTab>("props");
  useEffect(() => { setTab("props"); }, [sel.id]);

  // The Run tab only exists once this node has actually been run.
  const tabs: PanelTab[] = runStep && !runStep.passthrough
    ? ["props", "about", "code", "run"]
    : ["props", "about", "code"];
  // Don't strand the panel on a tab that just disappeared (run cleared).
  useEffect(() => {
    if (!tabs.includes(tab)) setTab("props");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStep]);

  const inEdges = useMemo(
    () => (node ? doc.edges.filter((e) => e.target === node.id) : []),
    [node, doc.edges],
  );
  const outEdges = useMemo(
    () => (node ? doc.edges.filter((e) => e.source === node.id) : []),
    [node, doc.edges],
  );
  const varUsage = useMemo(
    () => (node ? nodeVarUsage(node, resolveVariables(doc)) : []),
    [node, doc],
  );

  return (
    <div
      className="absolute top-0 z-10 flex h-full w-[280px] flex-col border-l border-line bg-surface"
      style={{ right: shiftLeft }}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span style={{ color: accent }}>
          {node ? <Glyph kind={node.type} size={13} /> : <ArrowGlyph />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
          {node ? (node.data.label || node.id) : edge ? `${edge.source} → ${edge.target}` : sel.id}
        </span>
        {onDelete && (node || edge) && (
          <button
            className="rounded px-1.5 py-0.5 text-[10.5px] font-medium text-ink-mute transition-colors hover:bg-danger/15 hover:text-danger"
            onClick={onDelete}
            title={
              node
                ? "Delete this node, its block and every edge touching it (⌫ · undo ⌘Z)"
                : "Delete this edge (⌫ · undo ⌘Z)"
            }
          >
            Delete
          </button>
        )}
        <button
          className="rounded px-1.5 text-[13px] leading-none text-ink-mute transition-colors hover:bg-white/10 hover:text-ink"
          onClick={onClose}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      {node && (
        <div className="flex border-b border-line">
          {tabs.map((t) => (
            <button
              key={t}
              className={`flex-1 py-2 text-[11px] font-medium capitalize transition-colors ${
                tab === t
                  ? "-mb-px border-b-2 border-accent text-ink"
                  : "text-ink-mute hover:text-ink-dim"
              }`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {node && tab === "props" && (
          <NodeForm key={sel.id} node={node} onCommit={onCommitNode} onRename={onRenameNode} />
        )}
        {node && tab === "about" && (
          <AboutView node={node} inEdges={inEdges} outEdges={outEdges} varUsage={varUsage} />
        )}
        {node && tab === "run" && runStep && <RunView step={runStep} />}
        {node && tab === "code" && (
          <CodeView
            key={sel.id}
            code={nodeCode}
            onApply={(text) => onCommitNodeCode(node.id, text)}
          />
        )}
        {edge && (
          <EdgeForm
            key={sel.id}
            edge={edge}
            onCommitLabel={onCommitEdgeLabel}
            onCommitNote={onCommitEdgeNote}
          />
        )}
        {!node && !edge && (
          <p className="text-[12px] text-ink-mute">this element is no longer in the doc</p>
        )}
      </div>
    </div>
  );
}

function AboutView({
  node,
  inEdges,
  outEdges,
  varUsage,
}: {
  node: FmlNode;
  inEdges: FmlEdge[];
  outEdges: FmlEdge[];
  varUsage: NodeVarUsage[];
}) {
  const note = node.data.note;
  const spec = nodeTypeSpec(node.type);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className={keyLabel}>type</div>
        <p className="mt-1 text-[11px] leading-snug text-ink-mute">
          {spec ? spec.summary : "Custom type — outside the standard vocabulary."}
        </p>
      </div>

      <div>
        <div className={keyLabel}>description</div>
        {note ? (
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink">{note}</p>
        ) : (
          <p className="mt-1.5 text-[11px] italic text-ink-mute">
            Add a <span className="font-mono">note:</span> in the Props tab to describe this node.
          </p>
        )}
      </div>

      {inEdges.length > 0 && (
        <div>
          <div className={keyLabel}>receives from</div>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {inEdges.map((e) => (
              <div key={e.id} className="flex flex-col gap-0.5">
                <span className="font-mono text-[11px] text-ink-dim">{e.source}</span>
                {e.label && (
                  <span className="ml-2 font-mono text-[10px] text-ink-mute">↳ {e.label}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {outEdges.length > 0 && (
        <div>
          <div className={keyLabel}>leads to</div>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {outEdges.map((e) => (
              <div key={e.id} className="flex flex-col gap-0.5">
                {e.label && (
                  <span className="ml-2 font-mono text-[10px] text-ink-mute">{e.label} ↴</span>
                )}
                <span className="font-mono text-[11px] text-ink-dim">{e.target}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {varUsage.length > 0 && (
        <div>
          <div className={keyLabel}>variables</div>
          <div className="mt-1.5 flex flex-col gap-1">
            {varUsage.map((u) => (
              <div key={u.name} className="flex items-baseline gap-1.5 font-mono text-[11px]">
                <span className="shrink-0 text-ink-dim">{`{${u.name}}`}</span>
                {u.resolved?.source === "vars" && (
                  <span className="min-w-0 truncate text-ink-mute">
                    → &quot;{u.resolved.value}&quot;
                  </span>
                )}
                {u.resolved?.source === "capture" && (
                  <span className="min-w-0 truncate text-ink-mute">
                    → captured by {u.resolved.capturedBy}
                  </span>
                )}
                {!u.resolved && (
                  <span className="min-w-0 truncate text-warn">→ not set, asked for when run</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {inEdges.length === 0 && outEdges.length === 0 && (
        <p className="text-[11px] italic text-ink-mute">No edges connected to this node.</p>
      )}
    </div>
  );
}

/** Raw FML for the node — decl line + `@node { }` block — editable and copyable. */
function CodeView({ code, onApply }: { code: string; onApply: (text: string) => void }) {
  const [text, setText] = useState(code);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setText(code);
  }, [code]);

  const dirty = text !== code;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className={keyLabel}>fml</div>
      <textarea
        className={`${field} min-h-[220px] resize-y leading-relaxed`}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <button
          className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-white/[0.06] hover:text-ink"
          onClick={copy}
        >
          {copied ? "copied" : "copy"}
        </button>
        <button
          className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
            dirty ? "bg-ink text-bg hover:opacity-90" : "border border-line text-ink-mute"
          }`}
          disabled={!dirty}
          onClick={() => onApply(text)}
        >
          apply
        </button>
        {dirty && (
          <button
            className="rounded-md px-2 py-1 text-[11px] text-ink-mute transition-colors hover:text-ink"
            onClick={() => setText(code)}
          >
            revert
          </button>
        )}
      </div>
      <p className="text-[11px] leading-snug text-ink-mute">
        Applies the type and the <span className="font-mono">@node</span> block. Comments inside the
        block aren&apos;t kept.
      </p>
    </div>
  );
}

function ArrowGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 8h11 M10 4.5 13.5 8 10 11.5" />
    </svg>
  );
}

/** Editable list of `key: value` rows shared by the node block and the edge note. */
function KeyValueRows({
  rows,
  setRows,
  commit,
  valuePlaceholder,
}: {
  rows: Row[];
  setRows: (r: Row[]) => void;
  commit: (r: Row[]) => void;
  valuePlaceholder?: (key: string) => string;
}) {
  const patch = (i: number, next: Row) => setRows(rows.map((r, j) => (j === i ? next : r)));

  return (
    <>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <input
              className={`${field} flex-1`}
              value={k}
              placeholder="key"
              onChange={(e) => patch(i, [e.target.value, v])}
              onBlur={() => commit(rows)}
            />
            <button
              className="rounded px-1.5 text-[12px] text-ink-mute transition-colors hover:bg-white/10 hover:text-ink"
              onClick={() => {
                const next = rows.filter((_, j) => j !== i);
                setRows(next);
                commit(next);
              }}
              title={`Remove ${k || "row"}`}
            >
              ✕
            </button>
          </div>
          <input
            className={field}
            value={v}
            placeholder={valuePlaceholder?.(k) ?? "value"}
            onChange={(e) => patch(i, [k, e.target.value])}
            onBlur={() => commit(rows)}
            onKeyDown={(e) => e.key === "Enter" && commit(rows)}
          />
        </div>
      ))}
    </>
  );
}

function NodeForm({
  node,
  onCommit,
  onRename,
}: {
  node: FmlNode;
  onCommit: (id: string, block: Record<string, string>, type: string) => void;
  onRename: (from: string, to: string) => boolean;
}) {
  const seed = (): Row[] => {
    const { label, ...meta } = node.data;
    const rows: Row[] = [];
    if (label !== undefined) rows.push(["label", label]);
    for (const [k, v] of Object.entries(meta)) rows.push([k, v]);
    return rows;
  };

  const [type, setType] = useState(node.type);
  const [rows, setRows] = useState<Row[]>(seed);

  useEffect(() => {
    setType(node.type);
    setRows(seed());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);

  const commit = (nextRows: Row[], nextType = type) =>
    onCommit(node.id, Object.fromEntries(nextRows.filter(([k]) => k.trim() !== "")), nextType);

  const addKey = (key: string) => {
    const next: Row[] = [...rows.filter(([k]) => k !== key), [key, ""]];
    setRows(next);
  };

  const spec = nodeTypeSpec(type);
  const present = new Set(rows.map(([k]) => k));
  const missing = missingKeys(type, Object.fromEntries(rows));
  const suggestions = spec ? spec.optional.filter((k) => !present.has(k)) : [];
  const options = isKnownType(type) ? NODE_TYPES.map((t) => t.type) : [type, ...NODE_TYPES.map((t) => t.type)];

  return (
    <div className="flex flex-col gap-3">
      <IdField id={node.id} onRename={onRename} />

      <div>
        <div className={keyLabel}>type</div>
        <select
          className={`${field} mt-1 cursor-pointer`}
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            commit(rows, e.target.value);
          }}
        >
          {options.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] leading-snug text-ink-mute">
          {spec
            ? spec.summary
            : type === UNTYPED
              ? "Never declared under @nodes — give it a type to make it mean something."
              : "Outside the standard vocabulary. It draws, but nothing can reason about it."}
        </p>
      </div>

      {missing.length > 0 && (
        <div className="rounded-lg border border-line bg-bg/60 p-2">
          <div className="text-[11px] text-ink-dim">
            A <span className="font-mono">{type}</span> is expected to carry:
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {missing.map((k) => (
              <button key={k} className={chip} onClick={() => addKey(k)}>
                + {k}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="h-px bg-line" />

      <KeyValueRows
        rows={rows}
        setRows={setRows}
        commit={commit}
        valuePlaceholder={(k) => (k === "label" ? node.id : "value")}
      />

      <div className="flex flex-wrap items-center gap-1">
        <button
          className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-white/[0.06] hover:text-ink"
          onClick={() => setRows([...rows, ["", ""]])}
        >
          + property
        </button>
        {suggestions.map((k) => (
          <button key={k} className={chip} onClick={() => addKey(k)}>
            + {k}
          </button>
        ))}
      </div>
    </div>
  );
}

function EdgeForm({
  edge,
  onCommitLabel,
  onCommitNote,
}: {
  edge: FmlEdge;
  onCommitLabel: (edge: FmlEdge, label: string) => void;
  onCommitNote: (edge: FmlEdge, data: Record<string, string>) => void;
}) {
  const [label, setLabel] = useState(edge.label);
  const [rows, setRows] = useState<Row[]>(() => Object.entries(edge.data ?? {}));

  useEffect(() => {
    setLabel(edge.label);
    setRows(Object.entries(edge.data ?? {}));
  }, [edge]);

  const commitNote = (next: Row[]) =>
    onCommitNote(edge, Object.fromEntries(next.filter(([k]) => k.trim() !== "")));

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className={keyLabel}>edge</div>
        <div className="mt-1 font-mono text-[12px] text-ink">
          {edge.source} <span className="text-ink-mute">→</span> {edge.target}
        </div>
      </div>

      <div>
        <div className={keyLabel}>label</div>
        <input
          className={`${field} mt-1`}
          value={label}
          placeholder="(none)"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => onCommitLabel(edge, label)}
          onKeyDown={(e) => e.key === "Enter" && onCommitLabel(edge, label)}
        />
        <p className="mt-1 text-[11px] leading-snug text-ink-mute">
          Shown on the arrow — a status, a trigger, a condition.
        </p>
      </div>

      <div className="h-px bg-line" />

      <div className={keyLabel}>note</div>
      <KeyValueRows rows={rows} setRows={setRows} commit={commitNote} />

      <button
        className="self-start rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-white/[0.06] hover:text-ink"
        onClick={() => setRows([...rows, ["", ""]])}
      >
        + note key
      </button>
    </div>
  );
}

/**
 * What actually happened at this node in the last run — the exact request that
 * went out, what came back, and what was pulled from it.
 *
 * This is the request/response inspector every API client has, except you get
 * to it by clicking the box on the map instead of hunting a list.
 */
function RunView({ step }: { step: StepResult }) {
  const pass = step.ok;
  const colour = pass ? "var(--color-api)" : "var(--color-danger)";

  if (step.skipped) {
    return (
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[11px] font-semibold text-ink-mute">SKIPPED</span>
        <p className="text-[11.5px] leading-relaxed text-ink-dim">{step.skipped}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-semibold" style={{ color: colour }}>
          {pass ? "PASSED" : "FAILED"}
        </span>
        {step.response && (
          <span className="font-mono text-[11px] tabular-nums text-ink-dim">
            {step.response.status}
          </span>
        )}
        {step.durationMs !== undefined && (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-mute">
            {step.durationMs}ms
          </span>
        )}
      </div>

      {step.error && (
        <p
          className="rounded-md border px-2 py-1.5 font-mono text-[10.5px] leading-relaxed"
          style={{
            color: colour,
            borderColor: `color-mix(in srgb, ${colour} 35%, transparent)`,
            background: `color-mix(in srgb, ${colour} 8%, transparent)`,
          }}
        >
          {step.error}
        </p>
      )}

      {step.captures.length > 0 && (
        <section>
          <div className={keyLabel}>captured</div>
          <div className="mt-1 flex flex-col gap-1">
            {step.captures.map((c) => (
              <div key={c.name} className="flex gap-2 font-mono text-[11px]">
                <span className="shrink-0 text-ink-dim">{c.name}</span>
                <span
                  className="min-w-0 flex-1 truncate"
                  style={{ color: c.ok ? "var(--color-ink)" : "var(--color-danger)" }}
                  title={c.ok ? c.value : `nothing at ${c.path}`}
                >
                  {c.ok ? c.value : `✖ nothing at ${c.path}`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {step.asserts.length > 0 && (
        <section>
          <div className={keyLabel}>asserted</div>
          <div className="mt-1 flex flex-col gap-1">
            {step.asserts.map((a) => (
              <div key={a.label} className="flex gap-2 font-mono text-[11px]">
                <span className="shrink-0 text-ink-dim">{a.label}</span>
                <span
                  className="min-w-0 flex-1 truncate"
                  style={{ color: a.ok ? "var(--color-ink)" : "var(--color-danger)" }}
                  title={a.ok ? `${a.expr} — got ${a.actual ?? "nothing"}` : `${a.expr} — ${a.message ?? "failed"}`}
                >
                  {a.ok ? `✔ ${a.expr}` : `✖ ${a.message ?? a.expr}`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {step.ui && step.ui.actions.length > 0 && (
        <section>
          <div className={keyLabel}>did</div>
          <div className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-ink">
            {step.ui.actions.map((a, i) => (
              <span key={i} className="truncate" title={a}>
                {a}
              </span>
            ))}
          </div>
        </section>
      )}

      {step.request && (
        <section>
          <div className={keyLabel}>request</div>
          <p className="mt-1 break-all font-mono text-[11px] text-ink">
            <span className="text-ink-dim">{step.request.method}</span> {step.request.url}
          </p>
          {Object.entries(step.request.headers).length > 0 && (
            <div className="mt-1.5 flex flex-col gap-0.5">
              {Object.entries(step.request.headers).map(([k, v]) => (
                <div key={k} className="flex gap-2 font-mono text-[10px]">
                  <span className="shrink-0 text-ink-mute">{k}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-dim" title={v}>
                    {v}
                  </span>
                </div>
              ))}
            </div>
          )}
          {step.request.body && <Body text={step.request.body} />}
        </section>
      )}

      {step.response && (
        <section>
          <div className={keyLabel}>response</div>
          <Body text={step.response.body} />
        </section>
      )}
    </div>
  );
}

/** Pretty-print JSON when it is JSON; show it verbatim when it isn't. */
function Body({ text }: { text: string }) {
  let shown = text;
  try {
    shown = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* not JSON — as-is */
  }
  return (
    <pre className="mt-1 max-h-[240px] overflow-auto rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-ink-dim">
      {shown || "(empty)"}
    </pre>
  );
}

/**
 * The node id, editable. Renaming rewrites every reference in the doc
 * (declaration, block, flow lines), so it commits on Enter / blur rather than
 * per keystroke, and an id that's invalid or taken just snaps back.
 */
function IdField({ id, onRename }: { id: string; onRename: (from: string, to: string) => boolean }) {
  const [draft, setDraft] = useState(id);
  const [rejected, setRejected] = useState(false);
  useEffect(() => {
    setDraft(id);
    setRejected(false);
  }, [id]);

  const valid = /^[A-Za-z0-9_]+$/.test(draft);
  const commit = () => {
    if (draft === id) return;
    if (valid && onRename(id, draft)) return;
    setRejected(true);
    setDraft(id);
  };

  return (
    <div>
      <div className={keyLabel}>id</div>
      <input
        className={`${field} mt-1 ${!valid || rejected ? "!border-danger/60" : ""}`}
        value={draft}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          setRejected(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(id);
            e.currentTarget.blur();
          }
        }}
        title="Letters, digits and _ — renames every reference in this doc"
      />
      {(!valid || rejected) && (
        <p className="mt-1 text-[10.5px] text-danger">
          {!valid ? "letters, digits and _ only" : "that id is already used in this doc"}
        </p>
      )}
    </div>
  );
}
