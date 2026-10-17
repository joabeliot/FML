import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
} from "@xyflow/react";
import { FmlNode } from "./nodes/FmlNode.tsx";
import { BubbleNode } from "./nodes/BubbleNode.tsx";
import { FlowEdge } from "./edges/FlowEdge.tsx";
import { DataEdge } from "./edges/DataEdge.tsx";
import { isDataHandle, isVarNodeId, nameOfHandle } from "../lib/dataWires.ts";
import { useForceLayout } from "../hooks/useForceLayout.ts";
import { nodeSize } from "../lib/layout.ts";
import { savePositions } from "../lib/nodePositions.ts";
import { VarNode } from "./nodes/VarNode.tsx";
import { TRACE_IN, TRACE_OUT } from "../lib/nodeStyle.ts";
import type { FmlFlowNode, FmlNodeData } from "../types/chart.ts";
import type { Selection } from "./PropertyPanel.tsx";

const nodeTypes = { fml: FmlNode, bubble: BubbleNode, var: VarNode };

/** Ceiling on how close the run camera gets — comfortable reading distance. */
const FOLLOW_ZOOM = 1.15;
const edgeTypes = { flow: FlowEdge, data: DataEdge };

/**
 * Space the floating chrome (toolbar, side panels) takes off the viewport, as a
 * React Flow padding object — so `fitView` never tucks a node underneath it.
 */
export type FitPadding = Record<"top" | "right" | "bottom" | "left", `${number}px`>;

export function fitPadding(insets: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}): FitPadding {
  return {
    top: `${insets.top}px`,
    right: `${insets.right}px`,
    bottom: `${insets.bottom}px`,
    left: `${insets.left}px`,
  };
}

interface Props {
  /** Freshly parsed + laid-out graph. New reference only when source/dir/strict changes. */
  chartNodes: FmlFlowNode[];
  chartEdges: Edge[];
  selection: Selection | null;
  onSelect: (sel: Selection | null) => void;
  /** Double-clicking a `flow` node drills into the doc it names. */
  onOpenDoc: (name: string) => void;
  /** Node id whose neighbourhood is spotlighted (via its step badge), or null. */
  trace: string | null;
  onTrace: (id: string | null) => void;
  /** Identifies the active doc for `nodePositions`, so a drag saves under the right key. */
  posDocKey: string;
  /**
   * Changes only when the *graph* changes — not when a run repaints it.
   * `chartNodes` / `chartEdges` now get a new identity on every run tick (live
   * pass/fail, the travelling pulse), and re-fitting the viewport on each of
   * those would yank the canvas around while you're trying to watch the run.
   */
  fitKey: string;
  /**
   * Where the run wants the camera. Driving it from here rather than from the
   * run hook because `useReactFlow` only exists inside the provider — the hook
   * says *what* to look at, this knows *how*.
   */
  focus?: { ids: string[]; nonce: number } | null;
  /**
   * A run is in progress (or has one queued). `useNodesInitialized()` isn't a
   * one-time "the graph is ready" flag — it can still blip false→true during
   * a run (one node's data object changing identity is enough), and that
   * blip is indistinguishable from a genuine first load. Rather than trying
   * to tell those apart, the structural auto-fit simply doesn't run at all
   * while this is true — a run already owns the camera.
   */
  runActive: boolean;
  /** Keeps `fitView` from tucking nodes under the toolbar or side panels. */
  padding: FitPadding;
  /**
   * Draw a new edge by dragging from one node's handle to another. Absent
   * (mid-run) means connecting is off.
   */
  onConnect?: (source: string, target: string) => void;
  /**
   * A data wire was dragged from `source`'s `capture.<name>` port and dropped
   * on `target` (anywhere on its card) at screen point `at` — FML-20.
   */
  /**
   * A data wire dropped on a node: on one of its input ports (`port` is that
   * port's name) or anywhere else on the card.
   */
  onDataDrop?: (source: string, name: string, target: string, at: { x: number; y: number }, port?: string) => void;
}

/** The input port on `nodeId` within 24px of a screen point, if any — a near miss on an 8px dot still counts. */
function nearestInputPort(nodeId: string, x: number, y: number): string | undefined {
  const card = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
  let best: { id: string; d: number } | undefined;
  for (const h of card?.querySelectorAll<HTMLElement>('.react-flow__handle[data-handleid^="d-in-"]') ?? []) {
    const r = h.getBoundingClientRect();
    const d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
    if (d <= 24 && (!best || d < best.d)) best = { id: h.dataset.handleid!, d };
  }
  return best?.id;
}

export function FlowCanvas({
  chartNodes,
  chartEdges,
  selection,
  onSelect,
  onOpenDoc,
  trace,
  onTrace,
  posDocKey,
  fitKey,
  focus,
  runActive,
  padding,
  onConnect,
  onDataDrop,
}: Props) {
  const { fitView, getNodes } = useReactFlow();
  const initialized = useNodesInitialized();

  const [nodes, setNodes, onNodesChange] = useNodesState<FmlFlowNode>(chartNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(chartEdges);

  // Repulsion that only exists *during* a drag — see useForceLayout. The id
  // currently being dragged is tracked outside React state (a ref, read fresh
  // each render) so its position always comes straight from React Flow's own
  // drag math, never a one-tick-stale physics position.
  const force = useForceLayout();
  const draggingId = useRef<string | null>(null);

  // Mirror the incoming graph. This runs often — every run tick hands down a
  // new array so live status reaches the nodes — so it stays cheap: no layout,
  // no viewport work. A drag mutates local state via onNodesChange and never
  // touches chartNodes, so hand-placed nodes stay where you drop them.
  useEffect(() => {
    setNodes(chartNodes);
    setEdges(chartEdges);
  }, [chartNodes, chartEdges, setNodes, setEdges]);

  // Only a real structural change drops the graph back to a static layout, so
  // no lingering push from a previous drag survives into a different doc.
  useEffect(() => {
    force.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  // Auto-fit only when the graph itself changes (new file / doc / direction) —
  // never when a panel opens. `padding` changes on every selection, so it is
  // read from a ref here instead of being a dependency, or each node click
  // would kick off a viewport animation.
  const paddingRef = useRef(padding);
  paddingRef.current = padding;

  // `useNodesInitialized()` isn't a one-time "the graph is ready" flag — it
  // can flip false→true again whenever a node's data object gets a new
  // identity (a run tick touching one node's `runState` is enough), because
  // React Flow re-measures on every node update. The `fitDoneFor` guard below
  // stops that from firing more than once *per graph* — but the very first
  // legitimate "true" can itself land squarely inside an already-running run
  // if the initial measurement pass simply hasn't finished by the time Run
  // was clicked, and there's no reliable way to tell that apart from a real
  // first load. So a run owns the camera outright: while one is active this
  // effect is a no-op, and it also marks this graph "already fitted" right
  // away — not just skipped-for-now — so nothing retroactively fires a
  // fit-all the instant the run ends and hands the camera back.
  const fitDoneFor = useRef<string | null>(null);
  useEffect(() => {
    if (runActive) {
      fitDoneFor.current = fitKey;
      return;
    }
    if (!initialized || fitDoneFor.current === fitKey) return;
    // `initialized` can still read true on the render where a node was just
    // added — it describes the graph *before* the newcomer was measured, and
    // fitView skips unmeasured nodes. Fitting then frames the old graph and
    // the guard stops the real fit ever happening, leaving the new node off
    // screen. Wait for every node to have a size; the hook flips false→true
    // once it does, which re-runs this.
    // The store is synced from `chartNodes` in an effect, so on the render
    // the key changes it may not even hold the new node yet.
    const inStore = getNodes();
    const have = new Set(inStore.map((n) => n.id));
    if (chartNodes.some((n) => !have.has(n.id)) || inStore.some((n) => !n.measured?.width)) return;
    fitDoneFor.current = fitKey;
    const id = requestAnimationFrame(() => void fitView({ padding: paddingRef.current, duration: 200 }));
    return () => cancelAnimationFrame(id);
  }, [runActive, initialized, fitKey, fitView, getNodes, chartNodes]);

  // Follow the run: settle on the node being called, then pull out to frame
  // both ends of the edge a request is crossing. `maxZoom` is what stops a
  // single small card from filling the screen — fitting one node alone would
  // otherwise zoom to 4x. A pair that sits far apart simply resolves to a
  // lower zoom on its own, so one cap handles both cases.
  useEffect(() => {
    if (!focus) return;
    void fitView({
      ...(focus.ids.length > 0 ? { nodes: focus.ids.map((id) => ({ id })) } : {}),
      padding: paddingRef.current,
      maxZoom: FOLLOW_ZOOM,
      duration: 300,
    });
    // Keyed on the nonce so focusing the same node twice still moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // Selection is owned by the app (the sidebar can drive it too), so the
  // rendered graph mirrors that rather than React Flow's internal flag.
  const selNodeId = selection?.kind === "node" ? selection.id : null;
  const selEdgeId = selection?.kind === "edge" ? selection.id : null;

  // The step badge toggles "trace" for its node. Read the current value from a
  // ref so this callback stays stable and doesn't churn the node memo.
  const traceRef = useRef(trace);
  traceRef.current = trace;
  const onBadge = useCallback(
    (id: string) => onTrace(traceRef.current === id ? null : id),
    [onTrace],
  );

  // Immediate predecessors / successors of the traced node, and each edge's
  // role in that neighbourhood. Null when nothing is traced.
  const traceView = useMemo(() => {
    if (!trace) return null;
    const preds = new Set<string>();
    const succs = new Set<string>();
    const edgeRole = new Map<string, "in" | "out">();
    for (const e of edges) {
      if (e.source === trace) {
        succs.add(e.target);
        edgeRole.set(e.id, "out");
      }
      if (e.target === trace) {
        preds.add(e.source);
        edgeRole.set(e.id, "in");
      }
    }
    return { preds, succs, edgeRole };
  }, [trace, edges]);

  const viewNodes = useMemo(
    () =>
      nodes.map((n) => {
        const selected = n.id === selNodeId;
        const role: FmlNodeData["traceRole"] = !traceView
          ? undefined
          : n.id === trace
            ? "self"
            : traceView.succs.has(n.id)
              ? "out"
              : traceView.preds.has(n.id)
                ? "in"
                : "dim";
        // The dragged node's position is React Flow's own — never override it
        // with a physics tick that may already be a frame behind the pointer.
        const forced = draggingId.current === n.id ? undefined : force.positions.get(n.id);
        const position = forced
          ? { x: forced.x - nodeSize(n.data).w / 2, y: forced.y - nodeSize(n.data).h / 2 }
          : n.position;
        const same =
          n.selected === selected &&
          n.data.traceRole === role &&
          n.data.onBadge === onBadge &&
          n.position.x === position.x &&
          n.position.y === position.y;
        return same
          ? n
          : { ...n, selected, position, data: { ...n.data, traceRole: role, onBadge } };
      }),
    [nodes, selNodeId, trace, traceView, onBadge, force.positions],
  );

  const viewEdges = useMemo(
    () =>
      edges.map((e) => {
        const selected = e.id === selEdgeId;
        if (!traceView) return e.selected === selected ? e : { ...e, selected };
        const role = traceView.edgeRole.get(e.id);
        const dim = !role;
        // Colour the connecting edges by direction — blue in, orange out —
        // same convention as the PREV/NEXT tag on the nodes at either end.
        const dirColor = role === "in" ? TRACE_IN : role === "out" ? TRACE_OUT : undefined;
        const marker =
          dirColor && e.markerEnd && typeof e.markerEnd === "object"
            ? { ...e.markerEnd, color: dirColor }
            : e.markerEnd;
        return {
          ...e,
          selected,
          markerEnd: dim ? undefined : marker,
          style: dim
            ? { ...e.style, opacity: 0.1 }
            : { ...e.style, opacity: 1, strokeWidth: 2.25, stroke: dirColor },
          data: { ...e.data, traceDim: dim, traceDir: role },
        };
      }),
    [edges, selEdgeId, traceView],
  );

  return (
    <>
      <ReactFlow
        nodes={viewNodes}
        edges={viewEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, n) => onSelect({ kind: "node", id: n.id })}
        onNodeDoubleClick={(_, n) => {
          const doc = n.data.kind === "flow" ? n.data.meta.doc : undefined;
          if (doc) onOpenDoc(doc);
        }}
        onEdgeClick={(_, e) => onSelect({ kind: "edge", id: e.id })}
        onPaneClick={() => {
          onSelect(null);
          onTrace(null);
        }}
        onNodeDragStart={() => {
          // Seed the push session from every node's current on-screen spot —
          // at rest this is just dagre's own layout, unchanged. Bubble frames
          // sit outside physics entirely (they're not draggable, and their own
          // sized-for-content footprint doesn't match `nodeSize`'s generic
          // card estimate) — their child cards still repel normally.
          force.onDragStart(nodes.filter((n) => n.type !== "bubble"));
        }}
        onNodeDrag={(_, node) => {
          draggingId.current = node.id;
          const { w, h } = nodeSize(node.data);
          force.onDrag(node.id, node.position.x + w / 2, node.position.y + h / 2);
        }}
        onNodeDragStop={(_, node, draggedNodes) => {
          draggingId.current = null;
          // Freeze exactly where the push left things — no settle, no snap-back.
          force.onDragEnd();
          // Positions never go into the .fml — save the drop point outside it,
          // right away, so it survives a doc switch instead of resetting to
          // auto-layout. Covers a multi-node drag too. Only the node(s) you
          // actually dragged are remembered — a neighbour that got shoved out
          // of the way reverts to dagre's own spot next time the doc parses.
          const moved = draggedNodes && draggedNodes.length > 0 ? draggedNodes : [node];
          const positions: Record<string, { x: number; y: number }> = {};
          for (const n of moved) positions[n.id] = n.position;
          savePositions(posDocKey, positions);
        }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // No `fitView` boolean here on purpose — that's React Flow's own
        // internal "fit once nodesInitialized flips true" behaviour, entirely
        // separate from and invisible to the guarded effect above. It doesn't
        // know about `runActive`, so on a run started before that first
        // initialization lands it fires its own fit-all mid-run regardless of
        // anything this component does — this WAS the actual remaining source
        // of the camera randomly zooming out. The effect above is the only
        // thing that does an initial fit now.
        nodesDraggable
        nodesConnectable={!!onConnect}
        // Control flow and data wires are two layers: a drag that starts on
        // one kind of handle can never complete on the other. Data drags
        // never complete through React Flow at all — they're resolved on
        // drop (onConnectEnd), because you drop a value onto a *card*, not
        // onto a port that doesn't exist yet.
        isValidConnection={(c) => !isDataHandle(c.sourceHandle) && !isDataHandle(c.targetHandle)}
        onConnect={(c) => {
          if (isDataHandle(c.sourceHandle) || isDataHandle(c.targetHandle)) return;
          if (c.source && c.target) onConnect?.(c.source, c.target);
        }}
        onConnectEnd={(event, state) => {
          // A completed handle-to-handle connection already went through onConnect.
          if (state.isValid) return;
          const from = state.fromHandle;
          if (!from || from.type !== "source") return;
          const point = "changedTouches" in event ? event.changedTouches[0] : event;
          if (!point) return;
          // Dropped on a card rather than exactly on its handle: React Flow
          // only connects within ~20px of a handle, so a drop on the card's
          // body silently did nothing. Treat the whole card as the target.
          const el = document.elementFromPoint(point.clientX, point.clientY);
          const target = el?.closest<HTMLElement>(".react-flow__node")?.dataset.id;
          if (!target) return;
          if (isDataHandle(from.id)) {
            // A variable node has nothing to receive.
            if (target === from.nodeId || isVarNodeId(target)) return;
            // The port React Flow snapped to (it snaps within a radius, so the
            // pointer needn't be exactly on the dot), else whatever's under it.
            // (Only a data input counts: a control-flow handle can sit right
            // beside a port, and snapping to it made the drop miss.)
            const snapped = state.toHandle?.nodeId === target && state.toHandle.id?.startsWith("d-in-") ? state.toHandle.id : undefined;
            const portId = snapped ?? nearestInputPort(target, point.clientX, point.clientY);
            const port = portId?.startsWith("d-in-") ? nameOfHandle(portId) : undefined;
            onDataDrop?.(from.nodeId, nameOfHandle(from.id!), target, { x: point.clientX, y: point.clientY }, port);
          } else if (!isVarNodeId(target)) {
            onConnect?.(from.nodeId, target);
          }
        }}
        // Deleting goes through the .fml (App's key handler), never React
        // Flow's local state — a node removed only on the canvas reappears on
        // the next parse.
        deleteKeyCode={null}
        edgesReconnectable={false}
        elementsSelectable
        minZoom={0.2}
        // Two-finger trackpad scroll pans (like Figma/Miro) instead of
        // zooming; pinch still zooms.
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
        className="bg-bg"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={2} color="#3d3d3d" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>

      {chartNodes.length === 0 && <EmptyCanvas />}
    </>
  );
}

function EmptyCanvas() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="max-w-[320px] text-center">
        <p className="text-[13px] text-ink-dim">Nothing to draw yet.</p>
        <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-ink-mute">
          Declare nodes under <span className="text-ink-dim">@nodes</span>, then wire them
          under <span className="text-ink-dim">@flow</span>. Open the Source panel to start.
        </p>
      </div>
    </div>
  );
}
