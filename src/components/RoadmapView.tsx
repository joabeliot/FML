// The roadmap view (FML-21, redrawn and made editable in FML-28): an .rml
// file drawn as a game skill tree.
//
// Roots sit at the centre and everything grows outward; each area keeps to
// its own wedge in its own colour. Square tiles are features (bigger when
// they unlock a lot), diamonds are milestones. Lit tiles are done or in
// progress; a dark tile with a coloured edge is READY (everything it needs
// is done); the rest are locked and dim. Lines turn gold once their
// prerequisite is done.
//
// Everything is editable here and written straight back into the .rml with
// the same surgical edits the flow view uses (⌘Z undoes): add a feature or
// milestone, drag a tile's handle onto another to make it a dependency,
// rename, change any field, delete.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { parse, type FmlDoc, type FmlNode } from "../fml/index.ts";
import {
  checkRoadmap,
  displayStates,
  progress,
  refsOf,
  RML_STATUSES,
  RML_VOCABULARY,
  statusOf,
  type RmlDisplay,
  type RmlIssue,
} from "../rml/rml.ts";
import { setNodeBlock, setNodeType } from "../lib/fmlEdit.ts";
import { addEdge, addNode, deleteEdge, deleteNode, ID_RE, renameNode, uniqueNodeId } from "../lib/fmlStructure.ts";
import { radialLayout } from "../lib/radialLayout.ts";
import { iconFor, RML_GLYPH_NAMES } from "../lib/rmlGlyphs.ts";

const LIT_PATH = "#e3b341";
const DARK_PATH = "#3b3328";
const CANVAS_BG = "#19140f";

/** Muted category fills, after the reference: maroon, navy, ochre, green… */
const AREA_FILLS = ["#5a2530", "#2e3a5c", "#5c4320", "#24453a", "#47305c", "#22495a", "#55511f"];

function areaFill(area: string | undefined, areas: string[]): string {
  if (!area) return "#3a3229";
  return AREA_FILLS[areas.indexOf(area) % AREA_FILLS.length] ?? "#3a3229";
}

interface TileData {
  node: FmlNode;
  display: RmlDisplay;
  fill: string;
  size: number;
  [key: string]: unknown;
}

type Tile = Node<TileData, "rml">;

/** Handles at the tile's centre, so straight lines run centre to centre. */
const CENTRE: CSSProperties = {
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 0,
  opacity: 0,
  pointerEvents: "none",
};

function RmlTile({ data, selected }: NodeProps<Tile>) {
  const { node, display, fill, size } = data;
  const milestone = node.type === "milestone";
  const lit = display === "done" || display === "active";
  const icon = iconFor(node.id, node.type, node.data.icon);
  const name = node.data.label || node.id;
  const description = node.data.description ?? node.data.note;

  const face: CSSProperties = lit
    ? {
        background: fill,
        borderColor: display === "active" ? LIT_PATH : `color-mix(in srgb, ${LIT_PATH} 45%, ${fill})`,
        boxShadow: display === "active" ? `0 0 0 3px rgba(227,179,65,0.22), 0 0 22px rgba(227,179,65,0.35)` : undefined,
      }
    : display === "ready"
      ? { background: `color-mix(in srgb, ${fill} 30%, #15110d)`, borderColor: `color-mix(in srgb, ${fill} 65%, #e8d9b8 35%)` }
      : { background: "#16120e", borderColor: "#2b241c" };
  const ink = lit ? "#f1d896" : display === "ready" ? "#cdb88c" : "#4a4137";
  const inner = milestone ? Math.round(size * 0.74) : size;

  return (
    <div className="group relative" style={{ width: size, height: size }}>
      <Handle id="c-in" type="target" position={Position.Top} style={CENTRE} isConnectable={false} />
      <Handle id="c" type="source" position={Position.Top} style={CENTRE} isConnectable={false} />
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="border-2"
          style={{
            width: inner,
            height: inner,
            borderRadius: milestone ? 7 : 9,
            transform: milestone ? "rotate(45deg)" : undefined,
            outline: selected ? "2px solid rgba(255,255,255,0.7)" : undefined,
            outlineOffset: 3,
            ...face,
          }}
        />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center" style={{ color: ink }}>
        {icon.path ? (
          <svg viewBox="0 0 16 16" width={size * 0.44} height={size * 0.44} fill="none" stroke="currentColor" strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={icon.path} />
          </svg>
        ) : (
          <span style={{ fontSize: size * 0.36 }}>{icon.text}</span>
        )}
      </div>
      {display === "ready" && (
        <span
          className="pointer-events-none absolute -right-1.5 -top-1.5 rounded px-1 font-mono text-[8px] uppercase leading-[14px] tracking-[0.06em]"
          style={{ background: CANVAS_BG, color: LIT_PATH, border: `1px solid ${LIT_PATH}55` }}
        >
          next
        </span>
      )}
      <div
        className="pointer-events-none absolute left-1/2 z-[1] w-max max-w-[130px] -translate-x-1/2 truncate rounded px-1 text-center text-[10.5px] leading-[15px]"
        style={{ top: size + 4, background: CANVAS_BG, color: lit ? "#d9c7a0" : display === "ready" ? "#a8977a" : "#655a4c" }}
      >
        {name}
      </div>
      {/* Drag from here onto another tile: that tile then depends on this one. */}
      <Handle
        id="link"
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !min-h-0 !min-w-0 cursor-crosshair !border-2 opacity-0 transition-opacity group-hover:opacity-100"
        style={{ background: CANVAS_BG, borderColor: LIT_PATH, right: -7, ...(selected ? { opacity: 1 } : {}) }}
        title="Drag onto another tile: it will depend on this one"
      />
      <div className="pointer-events-none absolute bottom-[calc(100%+10px)] left-1/2 z-30 hidden w-max max-w-[260px] -translate-x-1/2 rounded-lg border border-line bg-elevated px-2.5 py-1.5 shadow-[0_8px_24px_-6px_rgba(0,0,0,0.7)] group-hover:block">
        <div className="text-[11.5px] font-medium text-ink">{name}</div>
        <div className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-mute">{DISPLAY_SHORT[display]}</div>
        {description && <div className="mt-0.5 line-clamp-3 text-[10.5px] leading-snug text-ink-dim">{description}</div>}
      </div>
    </div>
  );
}

const DISPLAY_SHORT: Record<RmlDisplay, string> = { done: "done", active: "in progress", ready: "ready", locked: "locked" };

const nodeTypes = { rml: RmlTile };

interface Props {
  /** `.rml` file keys in the workspace (e.g. "roadmap.rml"). */
  files: string[];
  active: string | null;
  onActive: (key: string) => void;
  source: string;
  /** Rewrite the active roadmap file — every edit goes through this (undoable). */
  onEdit: (update: (text: string) => string) => void;
  /** `.fml` file keys loaded, so an `fml:` reference can be opened. */
  flowFiles: string[];
  onOpenFlow: (key: string) => void;
  onLoadExample: () => void;
  onNew: () => void;
  onRemove: (key: string) => void;
  /** Right-side space taken by the source panel. */
  rightInset: number;
}

/**
 * Its own React Flow store, not the app's: the flow canvas and this view
 * swap in place, and sharing one store let the flow canvas render a frame of
 * roadmap tiles (and vice versa) on every switch.
 */
export function RoadmapView(props: Props) {
  return (
    <ReactFlowProvider>
      <RoadmapCanvas {...props} />
    </ReactFlowProvider>
  );
}

const parseRml = (text: string) => parse(text, { strict: false, vocabulary: RML_VOCABULARY });

/** Would `source -> target` close a loop? (target already leads to source) */
function wouldCycle(doc: FmlDoc, source: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of doc.edges) if (e.source === id) stack.push(e.target);
  }
  return false;
}

function RoadmapCanvas(props: Props) {
  const { fitView } = useReactFlow();
  const [selId, setSelId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const parsed = useMemo(() => parseRml(props.source), [props.source]);
  const doc = parsed.doc;
  const issues = useMemo(() => checkRoadmap(doc), [doc]);
  const display = useMemo(() => displayStates(doc), [doc]);
  const areas = useMemo(() => [...new Set(doc.nodes.map((n) => n.data.area).filter((a): a is string => !!a))], [doc]);
  const positions = useMemo(
    () => radialLayout({ ids: doc.nodes.map((n) => n.id), edges: doc.edges, groupOf: (id) => doc.nodes.find((n) => n.id === id)?.data.area ?? "" }),
    [doc],
  );
  const done = progress(doc);

  const nodes = useMemo<Tile[]>(
    () =>
      doc.nodes.map((n) => {
        const unlocks = doc.edges.filter((e) => e.source === n.id).length;
        const size = n.type === "milestone" ? 68 : unlocks >= 3 ? 74 : 56;
        const p = positions.get(n.id) ?? { x: 0, y: 0 };
        return {
          id: n.id,
          type: "rml",
          position: { x: p.x - size / 2, y: p.y - size / 2 },
          draggable: false,
          selected: n.id === selId,
          data: { node: n, display: display.get(n.id) ?? "locked", fill: areaFill(n.data.area, areas), size },
        };
      }),
    [doc, positions, display, areas, selId],
  );
  const edges = useMemo<Edge[]>(
    () =>
      doc.edges.map((e) => {
        const lit = display.get(e.source) === "done";
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: "c",
          targetHandle: "c-in",
          type: "straight",
          selectable: false,
          style: { stroke: lit ? LIT_PATH : DARK_PATH, strokeWidth: lit ? 3 : 2 },
        };
      }),
    [doc, display],
  );

  // Refit when the roadmap itself changes shape (another file, nodes added).
  const shapeKey = `${props.active}|${doc.nodes.length}|${doc.edges.length}`;
  useEffect(() => {
    const id = requestAnimationFrame(() => void fitView({ padding: 0.18, duration: 200 }));
    return () => cancelAnimationFrame(id);
  }, [shapeKey, fitView]);

  useEffect(() => setSelId(null), [props.active]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);
  const sel = selId ? doc.nodes.find((n) => n.id === selId) : undefined;

  // -- edits (each one surgical, through onEdit so ⌘Z works) ---------------
  const docName = doc.name;
  const apply = useCallback(
    (next: string): boolean => {
      if (next === props.source) return false;
      props.onEdit(() => next);
      return true;
    },
    [props],
  );
  const setField = useCallback(
    (id: string, key: string, value: string) => {
      const node = doc.nodes.find((n) => n.id === id);
      if (!node) return;
      const data = { ...node.data };
      const v = value.replace(/[\r\n]+/g, " ").trim();
      if (v) data[key] = v;
      else delete data[key];
      apply(setNodeBlock(props.source, docName, id, data));
    },
    [doc, apply, props.source, docName],
  );
  const addTile = useCallback(
    (type: "feature" | "milestone") => {
      const id = uniqueNodeId(props.source, docName, type);
      let next = addNode(props.source, docName, id, type);
      // With a tile selected, the new one is what it unlocks.
      if (selId) next = addEdge(next, docName, { source: selId, target: id, label: "" });
      if (apply(next)) setSelId(id);
    },
    [props.source, docName, selId, apply],
  );
  const link = useCallback(
    (source: string, target: string) => {
      if (source === target) return;
      if (doc.edges.some((e) => e.source === source && e.target === target)) return setNotice(`${target} already depends on ${source}`);
      if (wouldCycle(doc, source, target)) return setNotice(`${source} already depends on ${target}: that would be a loop`);
      apply(addEdge(props.source, docName, { source, target, label: "" }));
    },
    [doc, apply, props.source, docName],
  );
  const unlink = useCallback(
    (source: string, target: string) => {
      const e = doc.edges.find((x) => x.source === source && x.target === target);
      if (e) apply(deleteEdge(props.source, docName, { source, target, label: e.label ?? "" }));
    },
    [doc, apply, props.source, docName],
  );
  const remove = useCallback(
    (id: string) => {
      if (apply(deleteNode(props.source, docName, id))) setSelId(null);
    },
    [apply, props.source, docName],
  );

  // Delete / Backspace removes the selected tile; Esc deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === "Escape") setSelId(null);
      if ((e.key === "Delete" || e.key === "Backspace") && selId) {
        e.preventDefault();
        remove(selId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selId, remove]);

  if (props.files.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center" style={{ background: CANVAS_BG }}>
        <div className="max-w-[380px] rounded-xl border border-line bg-surface p-5 text-center">
          <div className="text-[13px] font-medium text-ink">No roadmap loaded</div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-dim">
            Open a <span className="font-mono">.rml</span> file — features and milestones, where{" "}
            <span className="font-mono">A -&gt; B</span> means B depends on A — start a new one, or load F*ML's own roadmap.
          </p>
          <div className="mt-3 flex justify-center gap-2">
            <button className="rounded-lg bg-ink px-3 py-1.5 text-[11.5px] font-medium text-bg transition-opacity hover:opacity-90" onClick={props.onNew}>
              New roadmap
            </button>
            <button className="rounded-lg border border-line px-3 py-1.5 text-[11.5px] font-medium text-ink hover:border-line-strong" onClick={props.onLoadExample}>
              Load the example roadmap
            </button>
          </div>
        </div>
      </div>
    );
  }

  const barBtn = "rounded-lg px-2 py-1 text-[11px] font-medium text-ink-dim transition-colors hover:bg-white/[0.06] hover:text-ink";

  return (
    <div className="relative h-full w-full" style={{ background: CANVAS_BG }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesConnectable
        nodesDraggable={false}
        // Links are made on drop (onConnectEnd) onto a whole tile, never by
        // React Flow's handle-to-handle connect.
        isValidConnection={() => false}
        connectionLineStyle={{ stroke: LIT_PATH, strokeWidth: 2, strokeDasharray: "5 4" }}
        onConnectEnd={(event, state) => {
          const from = state.fromHandle;
          if (!from || from.id !== "link") return;
          const point = "changedTouches" in event ? event.changedTouches[0] : event;
          if (!point) return;
          const el = document.elementFromPoint(point.clientX, point.clientY);
          const target = el?.closest<HTMLElement>(".react-flow__node")?.dataset.id;
          if (target) link(from.nodeId, target);
        }}
        deleteKeyCode={null}
        minZoom={0.15}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        onNodeClick={(_, n) => setSelId(n.id)}
        onPaneClick={() => setSelId(null)}
        proOptions={{ hideAttribution: true }}
        style={{ background: CANVAS_BG }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="#2c2419" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>

      {/* Which roadmap, how far along, and adding to it. */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-xl border border-line bg-surface/85 px-2.5 py-1.5 backdrop-blur-md">
        {props.files.length > 1 ? (
          <select
            className="cursor-pointer bg-transparent font-mono text-[11px] text-ink outline-none"
            value={props.active ?? ""}
            onChange={(e) => props.onActive(e.target.value)}
          >
            {props.files.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        ) : (
          <span className="font-mono text-[11px] text-ink">{props.active}</span>
        )}
        <button
          className="text-[12px] leading-none text-ink-mute transition-colors hover:text-danger"
          title={`Remove ${props.active} from the workspace`}
          onClick={() => props.active && props.onRemove(props.active)}
        >
          ×
        </button>
        <span className="h-3.5 w-px bg-line" />
        <span className="font-mono text-[11px] tabular-nums text-ink-dim">
          {done.done}/{done.total} done
        </span>
        {(issues.length > 0 || parsed.errors.length > 0) && (
          <span
            className="font-mono text-[11px] text-warn"
            title={[...parsed.errors.map((e) => `line ${e.line}: ${e.message}`), ...issues.map((i) => `${i.nodeId}: ${i.message}`)].join("\n")}
          >
            {issues.length + parsed.errors.length} issue{issues.length + parsed.errors.length === 1 ? "" : "s"}
          </span>
        )}
        <span className="h-3.5 w-px bg-line" />
        <button className={barBtn} onClick={() => addTile("feature")} title={selId ? `Add a feature that ${selId} unlocks` : "Add a feature"}>
          + Feature
        </button>
        <button className={barBtn} onClick={() => addTile("milestone")} title={selId ? `Add a milestone that ${selId} unlocks` : "Add a milestone"}>
          + Milestone
        </button>
        {notice && <span className="text-[11px] text-warn">{notice}</span>}
      </div>

      {sel && (
        <RoadmapPanel
          key={sel.id}
          node={sel}
          doc={doc}
          areas={areas}
          display={display.get(sel.id) ?? "locked"}
          issues={issues.filter((i) => i.nodeId === sel.id)}
          flowFiles={props.flowFiles}
          onOpenFlow={props.onOpenFlow}
          onSelect={setSelId}
          onClose={() => setSelId(null)}
          onField={(key, value) => {
            // `pending` is the default status — written only if something else was there.
            if (key === "status" && value === "pending") return setField(sel.id, key, "");
            setField(sel.id, key, value);
          }}
          onType={(type) => apply(setNodeType(props.source, docName, sel.id, type))}
          onRename={(to) => {
            if (!ID_RE.test(to)) return "letters, digits and _ only";
            if (!apply(renameNode(props.source, docName, sel.id, to))) return "that id is already used";
            setSelId(to);
            return null;
          }}
          onLink={link}
          onUnlink={unlink}
          onDelete={() => remove(sel.id)}
          right={props.rightInset}
        />
      )}
    </div>
  );
}

const DISPLAY_LABEL: Record<RmlDisplay, string> = {
  done: "Done",
  active: "In progress",
  ready: "Ready — everything it needs is done",
  locked: "Locked — waiting on a dependency",
};

const label = "font-mono text-[10px] uppercase tracking-[0.08em] text-ink-mute";
const field =
  "mt-1 w-full rounded-md border border-line bg-bg px-2 py-1 text-[11.5px] text-ink outline-none focus:border-accent/60";

/** A text field that writes on Enter or blur — never per keystroke. */
function CommitField(props: {
  name: string;
  value: string;
  onCommit: (v: string) => void;
  mono?: boolean;
  multiline?: boolean;
  placeholder?: string;
  list?: string;
}) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  const commit = () => v !== props.value && props.onCommit(v);
  const cls = `${field} ${props.mono ? "font-mono" : ""}`;
  return (
    <label className="block">
      <span className={label}>{props.name}</span>
      {props.multiline ? (
        <textarea className={`${cls} min-h-[64px] resize-y leading-snug`} value={v} placeholder={props.placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} />
      ) : (
        <input
          className={cls}
          value={v}
          list={props.list}
          placeholder={props.placeholder}
          onChange={(e) => setV(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      )}
    </label>
  );
}

function RoadmapPanel({
  node,
  doc,
  areas,
  display,
  issues,
  flowFiles,
  onOpenFlow,
  onSelect,
  onClose,
  onField,
  onType,
  onRename,
  onLink,
  onUnlink,
  onDelete,
  right,
}: {
  node: FmlNode;
  doc: FmlDoc;
  areas: string[];
  display: RmlDisplay;
  issues: RmlIssue[];
  flowFiles: string[];
  onOpenFlow: (key: string) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  onField: (key: string, value: string) => void;
  onType: (type: string) => void;
  onRename: (to: string) => string | null;
  onLink: (source: string, target: string) => void;
  onUnlink: (source: string, target: string) => void;
  onDelete: () => void;
  right: number;
}) {
  const [id, setId] = useState(node.id);
  const [idError, setIdError] = useState<string | null>(null);
  const needs = doc.edges.filter((e) => e.target === node.id).map((e) => e.source);
  const unlocks = doc.edges.filter((e) => e.source === node.id).map((e) => e.target);
  const flows = refsOf(node.data.fml);
  const chip = "rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px]";
  const others = doc.nodes.map((n) => n.id).filter((x) => x !== node.id && !needs.includes(x));
  const commitId = () => {
    if (id === node.id) return;
    setIdError(onRename(id));
  };

  return (
    <div className="absolute top-0 z-10 flex h-full w-[290px] flex-col border-l border-line bg-surface" style={{ right }}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="text-[12px] text-ink-mute">{node.type === "milestone" ? "◆" : "■"}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{node.data.label || node.id}</span>
        <button className="rounded px-1.5 text-[11px] text-ink-mute hover:text-danger" onClick={onDelete} title="Delete this tile and its links">
          Delete
        </button>
        <button className="rounded px-1.5 text-[13px] leading-none text-ink-mute hover:bg-white/10 hover:text-ink" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-3">
        <div className="flex gap-2">
          <label className="block flex-1">
            <span className={label}>id</span>
            <input
              className={`${field} font-mono`}
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                setIdError(null);
              }}
              onBlur={commitId}
              onKeyDown={(e) => e.key === "Enter" && commitId()}
            />
          </label>
          <label className="block w-[104px]">
            <span className={label}>kind</span>
            <select className={`${field} cursor-pointer font-mono`} value={node.type} onChange={(e) => onType(e.target.value)}>
              <option value="feature">feature</option>
              <option value="milestone">milestone</option>
            </select>
          </label>
        </div>
        {idError && <p className="-mt-2 text-[10.5px] text-danger">{idError}</p>}

        <div>
          <label className="block">
            <span className={label}>status</span>
            <select aria-label="status" className={`${field} cursor-pointer font-mono`} value={statusOf(node)} onChange={(e) => onField("status", e.target.value)}>
              {RML_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-[10.5px] text-ink-mute">{DISPLAY_LABEL[display]}</p>
        </div>

        <CommitField name="title" value={node.data.label ?? ""} placeholder={node.id} onCommit={(v) => onField("label", v)} />
        <CommitField name="description" value={node.data.description ?? ""} multiline onCommit={(v) => onField("description", v)} />

        <div className="flex gap-2">
          <div className="flex-1">
            <CommitField name="area" value={node.data.area ?? ""} mono list="rml-areas" onCommit={(v) => onField("area", v)} />
            <datalist id="rml-areas">
              {areas.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
          <label className="block w-[104px]">
            <span className={label}>icon</span>
            <select className={`${field} cursor-pointer font-mono`} value={node.data.icon ?? ""} onChange={(e) => onField("icon", e.target.value)}>
              <option value="">auto</option>
              {RML_GLYPH_NAMES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              {node.data.icon && !RML_GLYPH_NAMES.includes(node.data.icon) && <option value={node.data.icon}>{node.data.icon}</option>}
            </select>
          </label>
        </div>

        <CommitField name="proven by (fml)" value={node.data.fml ?? ""} mono placeholder="auth, checkout" onCommit={(v) => onField("fml", v)} />
        {flows.length > 0 && (
          <div className="-mt-1.5 flex flex-wrap gap-1.5">
            {flows.map((f) => {
              const key = f.replace(/\.fml$/i, "").split("/").pop() ?? f;
              return flowFiles.includes(key) ? (
                <button key={f} className={`${chip} text-api hover:border-line-strong`} onClick={() => onOpenFlow(key)} title={`Open ${key}.fml`}>
                  {key}.fml ↗
                </button>
              ) : (
                <span key={f} className={`${chip} text-ink-mute`} title="Not loaded in this workspace">
                  {key}.fml
                </span>
              );
            })}
          </div>
        )}
        <CommitField name="tickets" value={node.data.ticket ?? ""} mono placeholder="FML-12, FML-13" onCommit={(v) => onField("ticket", v)} />

        <div>
          <div className={label}>depends on</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {needs.map((x) => (
              <span key={x} className={`${chip} flex items-center gap-1 text-ink`}>
                <button className="hover:underline" onClick={() => onSelect(x)}>
                  {doc.nodes.find((n) => n.id === x)?.data.label || x}
                </button>
                <button className="text-ink-mute hover:text-danger" onClick={() => onUnlink(x, node.id)} title={`No longer depends on ${x}`}>
                  ×
                </button>
              </span>
            ))}
            {others.length > 0 && (
              <select
                aria-label="add a dependency"
                className="cursor-pointer rounded-md border border-dashed border-line bg-transparent px-1 py-0.5 font-mono text-[10.5px] text-ink-mute outline-none"
                value=""
                onChange={(e) => e.target.value && onLink(e.target.value, node.id)}
              >
                <option value="">+ add</option>
                {others.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {unlocks.length > 0 && (
          <div>
            <div className={label}>unlocks</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {unlocks.map((x) => (
                <span key={x} className={`${chip} flex items-center gap-1 text-ink`}>
                  <button className="hover:underline" onClick={() => onSelect(x)}>
                    {doc.nodes.find((n) => n.id === x)?.data.label || x}
                  </button>
                  <button className="text-ink-mute hover:text-danger" onClick={() => onUnlink(node.id, x)} title={`${x} no longer depends on this`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {issues.length > 0 && (
          <div>
            <div className={label}>issues</div>
            {issues.map((i, k) => (
              <p key={k} className="mt-1 text-[11px] leading-snug text-warn">
                {i.message}
              </p>
            ))}
          </div>
        )}
        <p className="mt-auto text-[10.5px] leading-snug text-ink-mute">
          Drag a tile's gold handle onto another to make it a dependency. ⌘Z undoes any edit.
        </p>
      </div>
    </div>
  );
}
