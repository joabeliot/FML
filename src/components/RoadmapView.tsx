// The roadmap view (FML-21): an .rml file drawn as a tech tree.
//
// Left to right is "unlocks": a node sits right of everything it depends on.
// Lit tiles are done (or in progress), dark ones are locked, and a dark tile
// with a coloured outline is READY — everything it needs is done, so it's
// what's next. Connectors light gold once their prerequisite is done, the
// way an unlocked path lights up in a game's skill tree.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import dagre from "@dagrejs/dagre";
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
import { setNodeBlock } from "../lib/fmlEdit.ts";

const TILE_W = 156;
const TILE_H = 52;
const LIT_PATH = "#e3b341";
const DARK_PATH = "#3a3a3a";

/** Muted category fills, in the spirit of the reference: maroon, navy, ochre, green… */
const AREA_FILLS = ["#6e2f3a", "#33406b", "#6a4a22", "#2d5843", "#553a6b", "#2b5763", "#5e5a26"];

function areaFill(area: string | undefined, areas: string[]): string {
  if (!area) return "#3b3b3b";
  return AREA_FILLS[areas.indexOf(area) % AREA_FILLS.length] ?? "#3b3b3b";
}

interface TileData {
  node: FmlNode;
  display: RmlDisplay;
  fill: string;
  selected: boolean;
  [key: string]: unknown;
}

type Tile = Node<TileData, "rml">;

function RmlTile({ data }: NodeProps<Tile>) {
  const { node, display, fill, selected } = data;
  const milestone = node.type === "milestone";
  const lit = display === "done" || display === "active";
  const description = node.data.description ?? node.data.note;

  const style: CSSProperties = lit
    ? { background: fill, borderColor: display === "active" ? LIT_PATH : `color-mix(in srgb, ${LIT_PATH} 55%, ${fill})`, color: "#f3e6c8" }
    : display === "ready"
      ? { background: "#17171a", borderColor: `color-mix(in srgb, ${fill} 80%, white 20%)`, color: "#d8d2c4" }
      : { background: "#141416", borderColor: "#2a2a2e", color: "#5d5d63" };

  return (
    <div className="group relative">
      <Handle type="target" position={Position.Left} className="!h-1 !w-1 !border-0 !bg-transparent !opacity-0" />
      <Handle type="source" position={Position.Right} className="!h-1 !w-1 !border-0 !bg-transparent !opacity-0" />
      <div
        className={`flex items-center gap-2 border-2 px-2.5 transition-shadow ${milestone ? "rounded-[14px]" : "rounded-lg"} ${
          display === "active" ? "shadow-[0_0_0_3px_rgba(227,179,65,0.25)]" : ""
        } ${selected ? "ring-2 ring-white/60" : ""}`}
        style={{ width: TILE_W, height: TILE_H, ...style }}
      >
        <span className="shrink-0 text-[13px] leading-none" aria-hidden>
          {milestone ? "◆" : display === "done" ? "●" : display === "active" ? "◐" : "○"}
        </span>
        <span className={`min-w-0 flex-1 truncate text-[12px] ${milestone ? "font-semibold" : "font-medium"}`}>
          {node.data.label || node.id}
        </span>
        {display === "ready" && (
          <span className="shrink-0 rounded px-1 font-mono text-[8.5px] uppercase tracking-[0.08em]" style={{ color: LIT_PATH }}>
            next
          </span>
        )}
      </div>
      {/* Hover: the title and one line of description. */}
      <div className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-30 hidden w-max max-w-[260px] -translate-x-1/2 rounded-lg border border-line bg-elevated px-2.5 py-1.5 shadow-[0_8px_24px_-6px_rgba(0,0,0,0.7)] group-hover:block">
        <div className="text-[11.5px] font-medium text-ink">{node.data.label || node.id}</div>
        {description && <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-ink-dim">{description}</div>}
      </div>
    </div>
  );
}

const nodeTypes = { rml: RmlTile };

/**
 * Left-to-right tech-tree layout. A node's column is the earliest it can be:
 * one past its deepest prerequisite — so it sits right after what unlocks
 * it, not wherever dagre's balancing would drift it (which strung long
 * connectors behind unrelated tiles). dagre still decides the vertical order
 * within a column, which is what keeps crossings down; tiles are one fixed
 * size, so packing a column is exact.
 */
function layoutTree(doc: FmlDoc): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 26, ranksep: 70, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of doc.nodes) g.setNode(n.id, { width: TILE_W, height: TILE_H });
  for (const e of doc.edges) if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  dagre.layout(g);

  // Earliest column: longest path from any root. Memoised DFS; a cycle (an
  // RML error, flagged by checkRoadmap) is cut rather than looped on.
  const deps = new Map<string, string[]>();
  for (const e of doc.edges) deps.set(e.target, [...(deps.get(e.target) ?? []), e.source]);
  const col = new Map<string, number>();
  const visiting = new Set<string>();
  const columnOf = (id: string): number => {
    const known = col.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const c = Math.max(-1, ...(deps.get(id) ?? []).map(columnOf)) + 1;
    visiting.delete(id);
    col.set(id, c);
    return c;
  };

  const columns = new Map<number, string[]>();
  for (const n of doc.nodes) {
    const c = columnOf(n.id);
    columns.set(c, [...(columns.get(c) ?? []), n.id]);
  }

  const out = new Map<string, { x: number; y: number }>();
  for (const [c, ids] of columns) {
    const byY = ids.map((id) => ({ id, y: (g.node(id)?.y ?? 0) - TILE_H / 2 })).sort((a, b) => a.y - b.y);
    let floor = -Infinity;
    for (const { id, y } of byY) {
      const placed = Math.max(y, floor);
      out.set(id, { x: 24 + c * (TILE_W + 70), y: placed });
      floor = placed + TILE_H + 26;
    }
  }
  return out;
}

interface Props {
  /** `.rml` file keys in the workspace (e.g. "roadmap.rml"). */
  files: string[];
  active: string | null;
  onActive: (key: string) => void;
  source: string;
  /** Write the active roadmap file — status edits go through this. */
  onEdit: (update: (text: string) => string) => void;
  /** `.fml` file keys loaded, so an `fml:` reference can be opened. */
  flowFiles: string[];
  onOpenFlow: (key: string) => void;
  onLoadExample: () => void;
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

function RoadmapCanvas(props: Props) {
  const { fitView } = useReactFlow();
  const [selId, setSelId] = useState<string | null>(null);

  const parsed = useMemo(() => parse(props.source, { strict: false, vocabulary: RML_VOCABULARY }), [props.source]);
  const doc = parsed.doc;
  const issues = useMemo(() => checkRoadmap(doc), [doc]);
  const display = useMemo(() => displayStates(doc), [doc]);
  const areas = useMemo(() => [...new Set(doc.nodes.map((n) => n.data.area).filter((a): a is string => !!a))], [doc]);
  const positions = useMemo(() => layoutTree(doc), [doc]);
  const done = progress(doc);

  const nodes = useMemo<Tile[]>(
    () =>
      doc.nodes.map((n) => ({
        id: n.id,
        type: "rml",
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        draggable: false,
        data: { node: n, display: display.get(n.id) ?? "locked", fill: areaFill(n.data.area, areas), selected: n.id === selId },
      })),
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
          type: "smoothstep",
          selectable: false,
          style: { stroke: lit ? LIT_PATH : DARK_PATH, strokeWidth: lit ? 2.25 : 1.5 },
        };
      }),
    [doc, display],
  );

  // Refit when the roadmap itself changes shape (another file, nodes added).
  const shapeKey = `${props.active}|${doc.nodes.length}|${doc.edges.length}`;
  useEffect(() => {
    const id = requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 200 }));
    return () => cancelAnimationFrame(id);
  }, [shapeKey, fitView]);

  useEffect(() => setSelId(null), [props.active]);
  const sel = selId ? doc.nodes.find((n) => n.id === selId) : undefined;

  if (props.files.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg">
        <div className="max-w-[360px] rounded-xl border border-line bg-surface p-5 text-center">
          <div className="text-[13px] font-medium text-ink">No roadmap loaded</div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-dim">
            Open a <span className="font-mono">.rml</span> file — features and milestones, where{" "}
            <span className="font-mono">A -&gt; B</span> means B depends on A — or start from F*ML's own roadmap.
          </p>
          <button
            className="mt-3 rounded-lg bg-ink px-3 py-1.5 text-[11.5px] font-medium text-bg transition-opacity hover:opacity-90"
            onClick={props.onLoadExample}
          >
            Load the example roadmap
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        nodesDraggable={false}
        deleteKeyCode={null}
        minZoom={0.2}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        onNodeClick={(_, n) => setSelId(n.id)}
        onPaneClick={() => setSelId(null)}
        proOptions={{ hideAttribution: true }}
        className="bg-bg"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={2} color="#2e2a24" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>

      {/* Which roadmap, and how far along it is. */}
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
      </div>

      {sel && (
        <RoadmapPanel
          node={sel}
          doc={doc}
          display={display.get(sel.id) ?? "locked"}
          issues={issues.filter((i) => i.nodeId === sel.id)}
          flowFiles={props.flowFiles}
          onOpenFlow={props.onOpenFlow}
          onSelect={setSelId}
          onClose={() => setSelId(null)}
          onStatus={(status) => props.onEdit((text) => setStatusIn(text, sel.id, status))}
          right={props.rightInset}
        />
      )}
    </div>
  );
}

/**
 * Write `status:` for one node, through the same surgical block edit the
 * flow view uses — everything else in the file is left alone.
 */
function setStatusIn(text: string, id: string, status: string): string {
  const res = parse(text, { strict: false, vocabulary: RML_VOCABULARY });
  const node = res.doc.nodes.find((n) => n.id === id);
  if (!node) return text;
  // `pending` is the default — write it out only if something else was there,
  // so a sketch stays a sketch.
  const data = { ...node.data };
  if (status === "pending") delete data.status;
  else data.status = status;
  return setNodeBlock(text, res.doc.name, id, data);
}

const DISPLAY_LABEL: Record<RmlDisplay, string> = {
  done: "Done",
  active: "In progress",
  ready: "Ready — everything it needs is done",
  locked: "Locked — waiting on a dependency",
};

function RoadmapPanel({
  node,
  doc,
  display,
  issues,
  flowFiles,
  onOpenFlow,
  onSelect,
  onClose,
  onStatus,
  right,
}: {
  node: FmlNode;
  doc: FmlDoc;
  display: RmlDisplay;
  issues: RmlIssue[];
  flowFiles: string[];
  onOpenFlow: (key: string) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  onStatus: (status: string) => void;
  right: number;
}) {
  const label = "font-mono text-[10px] uppercase tracking-[0.08em] text-ink-mute";
  const needs = doc.edges.filter((e) => e.target === node.id).map((e) => e.source);
  const unlocks = doc.edges.filter((e) => e.source === node.id).map((e) => e.target);
  const flows = refsOf(node.data.fml);
  const tickets = refsOf(node.data.ticket);
  const chip = "rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px]";

  return (
    <div className="absolute top-0 z-10 flex h-full w-[280px] flex-col border-l border-line bg-surface" style={{ right }}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="text-[12px] text-ink-mute">{node.type === "milestone" ? "◆" : "■"}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{node.data.label || node.id}</span>
        <button className="rounded px-1.5 text-[13px] leading-none text-ink-mute hover:bg-white/10 hover:text-ink" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        <div>
          <div className={label}>status</div>
          <select
            className="mt-1 w-full cursor-pointer rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent/60"
            value={statusOf(node)}
            onChange={(e) => onStatus(e.target.value)}
          >
            {RML_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10.5px] text-ink-mute">{DISPLAY_LABEL[display]}</p>
        </div>

        {(node.data.description || node.data.note) && (
          <div>
            <div className={label}>description</div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink">{node.data.description ?? node.data.note}</p>
          </div>
        )}

        {node.data.area && (
          <div>
            <div className={label}>area</div>
            <p className="mt-1 font-mono text-[11px] text-ink-dim">{node.data.area}</p>
          </div>
        )}

        {flows.length > 0 && (
          <div>
            <div className={label}>proven by</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {flows.map((f) => {
                const key = f.replace(/\.fml$/i, "").split("/").pop() ?? f;
                const loaded = flowFiles.includes(key);
                return loaded ? (
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
          </div>
        )}

        {tickets.length > 0 && (
          <div>
            <div className={label}>tickets</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {tickets.map((t) => (
                <span key={t} className={`${chip} text-ink-dim`}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {[["depends on", needs] as const, ["unlocks", unlocks] as const].map(([title, ids]) =>
          ids.length > 0 ? (
            <div key={title}>
              <div className={label}>{title}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {ids.map((id) => (
                  <button key={id} className={`${chip} text-ink hover:border-line-strong`} onClick={() => onSelect(id)}>
                    {doc.nodes.find((n) => n.id === id)?.data.label || id}
                  </button>
                ))}
              </div>
            </div>
          ) : null,
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
      </div>
    </div>
  );
}
