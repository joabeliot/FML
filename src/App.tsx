import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ReactFlowProvider, type Edge } from "@xyflow/react";
import type { FmlDoc, FmlEdge } from "./fml/index.ts";
import { FlowCanvas, fitPadding } from "./components/FlowCanvas.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Toolbar } from "./components/Toolbar.tsx";
import { SourcePanel } from "./components/SourcePanel.tsx";
import { PropertyPanel, type Selection } from "./components/PropertyPanel.tsx";
import { WalkthroughPanel } from "./components/WalkthroughPanel.tsx";
import { RunBar, RUN_BAR_COLLAPSED_H, RUN_BAR_H } from "./components/RunBar.tsx";
import { RunInputs } from "./components/RunInputs.tsx";
import { useFlowRun } from "./hooks/useFlowRun.ts";
import { useFmlChart } from "./hooks/useFmlChart.ts";
import { useLocalStorage } from "./hooks/useLocalStorage.ts";
import { SAMPLE_FML } from "./lib/sample.ts";
import {
  nodeSource,
  setEdgeLabel,
  setEdgeNote,
  setNodeBlock,
  setNodeSource,
  setNodeType,
} from "./lib/fmlEdit.ts";
import { addEdge, addNode, deleteEdge, deleteNode, renameNode, uniqueNodeId } from "./lib/fmlStructure.ts";
import { expandPortal, type BubbleGraph } from "./lib/expandPortal.ts";
import { docPositionKey, renamePosition } from "./lib/nodePositions.ts";
import { dataGraph, inHandle, outHandle, visibleDataGraph, wireOptions } from "./lib/dataWires.ts";
import { DataWirePicker } from "./components/DataWirePicker.tsx";
import { nodeSize } from "./lib/layout.ts";
import type { FmlFlowNode } from "./types/chart.ts";
import { fileKey, type Workspace } from "./types/workspace.ts";

const WS_KEY = "protoarque_fml_ws";

/** Widths of the docked panels, shared by the layout and by fitView's padding. */
const PROPERTY_W = 280;
const SOURCE_W = 400;
/** Room for the floating toolbar at the top of the canvas. */
const TOOLBAR_H = 60;
const GUTTER = 28;

const sampleWorkspace = (): Workspace => ({ files: { sample: SAMPLE_FML }, entry: "sample" });

function initialWorkspace(): Workspace {
  try {
    const stored = localStorage.getItem(WS_KEY);
    if (stored) return JSON.parse(stored) as Workspace;
    const legacy = localStorage.getItem("protoarque_fml_source");
    if (legacy) return { files: { main: JSON.parse(legacy) as string }, entry: "main" };
  } catch {
    /* fall through to the sample */
  }
  return sampleWorkspace();
}

/** After files are added or removed, choose which one to parse from. */
function pickEntry(files: Record<string, string>, current: string): string {
  if (files[current]) return current;
  const withFof = Object.keys(files).find((k) => /^@fof\b/m.test(files[k] ?? ""));
  return withFof ?? (files.app ? "app" : files.main ? "main" : Object.keys(files)[0] ?? "main");
}

export function App() {
  const [ws, setWs] = useLocalStorage<Workspace>(WS_KEY, initialWorkspace());
  const [sidebarOpen, setSidebarOpen] = useLocalStorage("protoarque_fml_sidebar", true);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  // Node id whose neighbourhood is spotlighted, set by clicking a step badge.
  const [trace, setTrace] = useState<string | null>(null);
  // Portal node ids currently unfolded inline as a bubble.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Executing the flow: engine state, plus the bar that reports it.
  const run = useFlowRun();
  const [runBarOpen, setRunBarOpen] = useState(true);
  const [askingInputs, setAskingInputs] = useState<string[] | null>(null);

  // Layout is always top-down; strict validation stays off (loose mode).
  const chart = useFmlChart(ws, activeDoc, "TB", false);

  // Data wires (FML-20): every capture → {name} link in the active doc. All
  // of them with the Data toggle on; otherwise just the selected node's.
  const [dataOn, setDataOn] = useLocalStorage("protoarque_fml_datawires", false);
  const fullData = useMemo(() => dataGraph(chart.doc), [chart.doc]);
  const shownData = useMemo(
    () => visibleDataGraph(fullData, dataOn, sel?.kind === "node" ? sel.id : null),
    [fullData, dataOn, sel],
  );
  const [pendingWire, setPendingWire] = useState<{
    source: string;
    name: string;
    target: string;
    at: { x: number; y: number };
  } | null>(null);

  // A trace id / expanded bubble is doc-local; drop both whenever the doc or file changes.
  useEffect(() => {
    setTrace(null);
    setExpanded(new Set());
    // A run belongs to the doc it ran against — carrying green ticks over to a
    // different flow would be a lie.
    run.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.activeDoc, ws.entry]);

  const apiNodeCount = useMemo(
    () => chart.doc.nodes.filter((n) => n.type === "api").length,
    [chart.doc],
  );

  // Ask for run-time inputs first when the file can't supply them; otherwise go.
  const startRun = useCallback(() => {
    const needed = run.inputsNeeded(chart.doc);
    if (needed.length > 0) {
      setAskingInputs(needed);
      return;
    }
    setRunBarOpen(true);
    run.start(chart.doc, {});
  }, [chart.doc, run]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Collapsing orphans anything selected inside that bubble — drop it
        // rather than leave the property panel pointing at a namespaced id
        // that no longer resolves to any rendered node.
        setSel((s) => (s && s.id.startsWith(`${id}::`) ? null : s));
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // One laid-out sub-graph per currently-expanded portal, anchored just below
  // its card. Recomputed fresh from dagre every time — nothing here persists.
  const bubbles = useMemo(() => {
    const out: BubbleGraph[] = [];
    for (const portalId of expanded) {
      const portalNode = chart.nodes.find((n) => n.id === portalId);
      if (!portalNode || portalNode.data.kind !== "flow") continue;
      const targetName = portalNode.data.meta.doc;
      const targetDoc = targetName ? chart.file.docs.find((d) => d.name === targetName) : undefined;
      if (!targetDoc) continue;
      const { w, h } = nodeSize(portalNode.data);
      out.push(
        expandPortal(
          portalId,
          { x: portalNode.position.x, y: portalNode.position.y, w, h },
          targetDoc,
          "TB",
        ),
      );
    }
    return out;
  }, [expanded, chart.nodes, chart.file]);

  // Namespaced bubble-child id -> the real doc + node id it stands in for.
  const bubbleIdMap = useMemo(() => {
    const m = new Map<string, { doc: string; rawId: string }>();
    for (const b of bubbles) for (const [k, v] of b.idMap) m.set(k, v);
    return m;
  }, [bubbles]);

  // What the canvas actually renders: the active doc's own graph, portal cards
  // wired up to toggle their bubble, plus every expanded bubble's content.
  // Reused across renders so a node whose status *hasn't* changed this tick
  // keeps the exact same object reference — see the note inside the memo.
  const nodeCacheRef = useRef<{ chartNodes: FmlFlowNode[]; byId: Map<string, FmlFlowNode> }>({
    chartNodes: [],
    byId: new Map(),
  });

  const canvasNodes = useMemo(() => {
    const ran = run.status !== "idle";
    // A real doc/parse change invalidates the whole cache — every id's base
    // data is fresh anyway.
    if (nodeCacheRef.current.chartNodes !== chart.nodes) {
      nodeCacheRef.current = { chartNodes: chart.nodes, byId: new Map() };
    }
    const cache = nodeCacheRef.current.byId;
    const nextCache = new Map<string, FmlFlowNode>();

    const withState = chart.nodes.map((n) => {
      const needsExpand = n.data.kind === "flow";
      // A node the finished run never reached recedes rather than sitting
      // there looking equally relevant to the ones that actually executed.
      const state = ran
        ? (run.nodeState.get(n.id) ?? (run.status === "done" && !run.visited.has(n.id) ? "skipped" : undefined))
        : undefined;
      const wantExpanded = needsExpand ? expanded.has(n.id) : undefined;

      const cached = cache.get(n.id);
      // Reuse the SAME object when nothing about this node actually changed.
      // React Flow re-measures a node whenever its data object gets a new
      // identity — giving all 13 nodes a fresh object on *every* run tick
      // (instead of just the one whose status changed) meant no node ever
      // stayed "measured" for more than an instant, which starved
      // useNodesInitialized() of the stability it needs to settle. That let a
      // stray one-time fit-all (see FlowCanvas) land at an arbitrary moment
      // mid-run instead of only at genuine load — the actual cause of the
      // camera appearing to randomly zoom out during a run.
      const ports = shownData.ports.get(n.id);
      if (
        cached &&
        cached.data.runState === state &&
        cached.data.expanded === wantExpanded &&
        cached.data.ports === ports
      ) {
        nextCache.set(n.id, cached);
        return cached;
      }

      const built: FmlFlowNode = {
        ...n,
        data: {
          ...n.data,
          ...(needsExpand ? { expanded: wantExpanded, onExpand: toggleExpand } : {}),
          ...(ran ? { runState: state } : {}),
          ...(ports ? { ports } : {}),
        },
      };
      nextCache.set(n.id, built);
      return built;
    });

    nodeCacheRef.current.byId = nextCache;
    return [...withState, ...bubbles.flatMap((b) => b.nodes)];
  }, [chart.nodes, expanded, toggleExpand, bubbles, run.status, run.nodeState, run.visited, shownData]);

  // Same reuse trick as canvasNodes — same reasoning: an edge that's neither
  // the active one nor was just taken shouldn't get a new object every tick.
  const edgeCacheRef = useRef<{ chartEdges: Edge[]; byId: Map<string, Edge> }>({
    chartEdges: [],
    byId: new Map(),
  });

  const canvasEdges = useMemo(() => {
    const ran = run.status !== "idle";
    if (edgeCacheRef.current.chartEdges !== chart.edges) {
      edgeCacheRef.current = { chartEdges: chart.edges, byId: new Map() };
    }
    const cache = edgeCacheRef.current.byId;
    const nextCache = new Map<string, Edge>();

    const own = chart.edges.map((e) => {
      const active = ran && e.id === run.activeEdge;
      const taken = ran && run.takenEdges.has(e.id);
      const cached = cache.get(e.id);
      if (cached && cached.data?.runActive === active && cached.data?.runTaken === taken) {
        nextCache.set(e.id, cached);
        return cached;
      }
      const built: Edge = { ...e, data: { ...e.data, runActive: active, runTaken: taken } };
      nextCache.set(e.id, built);
      return built;
    });

    edgeCacheRef.current.byId = nextCache;
    return [...own, ...bubbles.flatMap((b) => b.edges)];
  }, [chart.edges, bubbles, run.status, run.activeEdge, run.takenEdges]);

  // Data wires ride on top of the control-flow graph. Kept out of layout and
  // out of the fit key — showing them must never move a node or the camera.
  const dataEdges = useMemo<Edge[]>(
    () =>
      shownData.wires.map((w) => ({
        id: w.id,
        source: w.source,
        target: w.target,
        sourceHandle: outHandle(w.name),
        targetHandle: inHandle(w.name),
        type: "data",
        selectable: false,
        focusable: false,
      })),
    [shownData],
  );
  const allEdges = useMemo(() => [...canvasEdges, ...dataEdges], [canvasEdges, dataEdges]);

  // A selection may be a bubble child — resolve it back to the doc + raw id
  // it actually represents, so edits land in the right file.
  const selResolved = useMemo(() => {
    if (!sel) return null;
    const mapped = bubbleIdMap.get(sel.id);
    if (mapped) {
      const doc = chart.file.docs.find((d) => d.name === mapped.doc);
      if (doc) return { doc, rawId: mapped.rawId };
    }
    return { doc: chart.doc, rawId: sel.id };
  }, [sel, bubbleIdMap, chart.file, chart.doc]);

  const addFiles = useCallback(
    (added: Record<string, string>) => {
      setWs((prev) => {
        const files = { ...prev.files, ...added };
        return { files, entry: pickEntry(files, prev.entry) };
      });
      setActiveDoc(null);
      setSel(null);
    },
    [setWs],
  );

  const removeFile = useCallback(
    (name: string) => {
      setWs((prev) => {
        const files = { ...prev.files };
        delete files[name];
        if (Object.keys(files).length === 0) return sampleWorkspace();
        return { files, entry: pickEntry(files, prev.entry) };
      });
      setActiveDoc(null);
      setSel(null);
    },
    [setWs],
  );

  const setEntry = useCallback(
    (name: string) => {
      setWs((prev) => ({ ...prev, entry: name }));
      setActiveDoc(null);
      setSel(null);
    },
    [setWs],
  );

  const setEntrySource = useCallback(
    (text: string) => setWs((prev) => ({ ...prev, files: { ...prev.files, [prev.entry]: text } })),
    [setWs],
  );

  // The file the current selection must be written back into — the active
  // doc by default, or whichever doc a bubble-child selection resolves to.
  const editTarget = useMemo(() => {
    const doc = selResolved?.doc ?? chart.doc;
    const file = doc.source ? fileKey(doc.source) : ws.entry;
    // Inside its own file an @fof'd doc is just "main".
    const docName = doc.source ? "main" : doc.name;
    return { file, docName };
  }, [selResolved, chart.doc, ws.entry]);

  const writeFile = useCallback(
    (updater: (text: string) => string) => {
      const { file } = editTarget;
      setWs((prev) => ({ ...prev, files: { ...prev.files, [file]: updater(prev.files[file] ?? "") } }));
    },
    [editTarget, setWs],
  );

  const commitNode = useCallback(
    (id: string, block: Record<string, string>, type: string) => {
      const doc = selResolved?.doc ?? chart.doc;
      const node = doc.nodes.find((n) => n.id === id);
      writeFile((text) => {
        let out = text;
        if (node && type !== node.type) out = setNodeType(out, editTarget.docName, id, type);
        return setNodeBlock(out, editTarget.docName, id, block);
      });
    },
    [selResolved, chart.doc, editTarget, writeFile],
  );

  const commitEdgeLabel = useCallback(
    (edge: FmlEdge, label: string) => {
      writeFile((text) => setEdgeLabel(text, editTarget.docName, edge, label));
    },
    [editTarget, writeFile],
  );

  const commitEdgeNote = useCallback(
    (edge: FmlEdge, data: Record<string, string>) => {
      writeFile((text) => setEdgeNote(text, editTarget.docName, edge, data));
    },
    [editTarget, writeFile],
  );

  const commitNodeCode = useCallback(
    (id: string, text: string) => {
      writeFile((src) => setNodeSource(src, editTarget.docName, id, text));
    },
    [editTarget, writeFile],
  );

  // -- structural edits (FML-22) --------------------------------------------
  // Add / delete / rename nodes, add / delete edges. Each is one surgical text
  // edit (src/lib/fmlStructure.ts), so the source panel shows exactly what
  // the canvas did. Every one is undoable with ⌘Z — a delete takes a node's
  // metadata and edges with it, and the file is the only copy.

  /** Which file + doc name an edit to `doc` lands in (an @fof doc is "main" in its own file). */
  const targetOf = useCallback(
    (doc: FmlDoc) => ({
      file: doc.source ? fileKey(doc.source) : ws.entry,
      docName: doc.source ? "main" : doc.name,
    }),
    [ws.entry],
  );

  const undoStack = useRef<Array<{ file: string; text: string }>>([]);

  /** Apply one structural edit; false when it was a no-op (taken id, nothing there). */
  const structural = useCallback(
    (doc: FmlDoc, edit: (text: string, docName: string) => string): boolean => {
      const { file, docName } = targetOf(doc);
      const before = ws.files[file] ?? "";
      const after = edit(before, docName);
      if (after === before) return false;
      undoStack.current = [...undoStack.current.slice(-49), { file, text: before }];
      setWs((prev) => ({ ...prev, files: { ...prev.files, [file]: after } }));
      return true;
    },
    [targetOf, ws.files, setWs],
  );

  const undo = useCallback(() => {
    const last = undoStack.current.pop();
    if (!last) return;
    setWs((prev) => ({ ...prev, files: { ...prev.files, [last.file]: last.text } }));
    setSel(null);
  }, [setWs]);

  const createNode = useCallback(
    (type: string) => {
      const doc = chart.doc;
      const { file, docName } = targetOf(doc);
      const id = uniqueNodeId(ws.files[file] ?? "", docName, type);
      if (structural(doc, (text, name) => addNode(text, name, id, type))) setSel({ kind: "node", id });
    },
    [chart.doc, targetOf, ws.files, structural],
  );

  const connect = useCallback(
    (source: string, target: string) => {
      // Bubble children belong to another doc — an edge can't cross into one.
      if (source.includes("::") || target.includes("::")) return;
      const base = `edge_${source}_${target}`;
      const existing = chart.doc.edges.filter((e) => e.source === source && e.target === target).length;
      if (structural(chart.doc, (text, name) => addEdge(text, name, { source, target, label: "" }))) {
        // Select it so the label can be typed straight away.
        setSel({ kind: "edge", id: existing === 0 ? base : `${base}_${existing}` });
      }
    },
    [chart.doc, structural],
  );

  const deleteSelected = useCallback(() => {
    if (!sel || !selResolved) return;
    const { doc, rawId } = selResolved;
    if (sel.kind === "node") {
      if (structural(doc, (text, name) => deleteNode(text, name, rawId))) setSel(null);
      return;
    }
    const edge = doc.edges.find((e) => e.id === rawId);
    if (edge && structural(doc, (text, name) => deleteEdge(text, name, edge))) setSel(null);
  }, [sel, selResolved, structural]);

  const renameSelected = useCallback(
    (from: string, to: string): boolean => {
      if (!selResolved) return false;
      const { doc } = selResolved;
      if (!structural(doc, (text, name) => renameNode(text, name, from, to))) return false;
      renamePosition(docPositionKey(ws.entry, doc), from, to);
      // A bubble child's selection id is namespaced — keep the prefix.
      setSel((s) => (s ? { ...s, id: s.id === from ? to : s.id.replace(new RegExp(`::${from}$`), `::${to}`) } : s));
      return true;
    },
    [selResolved, structural, ws.entry],
  );

  // Dropping a data wire: put `{name}` into the field the person picks.
  const pickWire = useCallback(
    (key: string, value: string) => {
      if (!pendingWire) return;
      const { target, name } = pendingWire;
      const node = chart.doc.nodes.find((n) => n.id === target);
      setPendingWire(null);
      if (!node) return;
      const ref = `{${name}}`;
      // A typed key that already exists gets the reference appended, never replaced.
      const prev = node.data[key]?.trim();
      const next = value === ref && prev && !prev.includes(ref) ? `${prev} ${ref}` : value;
      if (structural(chart.doc, (text, docName) => setNodeBlock(text, docName, target, { ...node.data, [key]: next }))) {
        setSel({ kind: "node", id: target });
      }
    },
    [pendingWire, chart.doc, structural],
  );

  // Literal FML for the selected node — shown in the property panel's Code tab.
  const selNodeCode = useMemo(() => {
    if (sel?.kind !== "node" || !selResolved) return "";
    return nodeSource(ws.files[editTarget.file] ?? "", editTarget.docName, selResolved.rawId);
  }, [sel, selResolved, ws.files, editTarget]);

  // Drilling into a `flow` portal: `doc:` names a doc in the parsed file.
  const openDoc = useCallback(
    (name: string) => {
      if (!chart.docs.includes(name)) return;
      setActiveDoc(name);
      setSel(null);
    },
    [chart.docs],
  );

  const onDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const picked = Array.from(e.dataTransfer.files ?? []).filter((f) => f.name.endsWith(".fml"));
      if (picked.length === 0) return;
      const added: Record<string, string> = {};
      for (const f of picked) added[fileKey(f.name)] = await f.text();
      addFiles(added);
    },
    [addFiles],
  );

  // Esc clears the selection; ⌘\ / Ctrl+\ toggles the sidebar; Delete /
  // Backspace removes the selection; ⌘Z undoes a structural edit. All are
  // ignored while a field has focus so they never fight with typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if (e.key === "Escape" && !typing) {
        setSel(null);
        setTrace(null);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !typing && run.status !== "running") {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !typing) {
        e.preventDefault();
        undo();
      }
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebarOpen, deleteSelected, undo, run.status]);

  const fileNames = useMemo(() => Object.keys(ws.files), [ws.files]);

  // Identity of the *graph*, so the canvas refits when the doc actually
  // changes but sits still while a run repaints it.
  const fitKey = useMemo(
    () => `${ws.entry}|${chart.activeDoc}|${canvasNodes.length}|${canvasEdges.length}`,
    [ws.entry, chart.activeDoc, canvasNodes.length, canvasEdges.length],
  );

  const runBarH =
    run.status === "idle" ? 0 : runBarOpen ? RUN_BAR_H : RUN_BAR_COLLAPSED_H;

  const padding = useMemo(
    () =>
      fitPadding({
        top: TOOLBAR_H,
        right: GUTTER + (sel ? PROPERTY_W : 0) + (sourceOpen ? SOURCE_W : 0),
        bottom: GUTTER + runBarH,
        left: GUTTER,
      }),
    [sel, sourceOpen, runBarH],
  );

  return (
    <ReactFlowProvider>
      <div className="flex h-full w-full">
        {sidebarOpen && (
          <Sidebar
            files={fileNames}
            entry={ws.entry}
            onEntry={setEntry}
            onRemoveFile={removeFile}
            docs={chart.docs}
            activeDoc={chart.activeDoc}
            onActiveDoc={setActiveDoc}
            nodes={chart.nodes}
            stats={chart.stats}
            selection={sel}
            onSelect={setSel}
            onCollapse={() => setSidebarOpen(false)}
          />
        )}

        <div className="relative flex-1" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
          <FlowCanvas
            chartNodes={canvasNodes}
            chartEdges={allEdges}
            selection={sel}
            onSelect={setSel}
            onOpenDoc={openDoc}
            trace={trace}
            onTrace={setTrace}
            posDocKey={chart.posDocKey}
            fitKey={fitKey}
            focus={run.focus}
            runActive={run.status !== "idle"}
            padding={padding}
            onConnect={run.status === "running" ? undefined : connect}
            onDataDrop={(source, name, target, at) => {
              // Bubble children belong to another doc.
              if (target.includes("::")) return;
              setPendingWire({ source, name, target, at });
            }}
          />
          <Toolbar
            sourceOpen={sourceOpen}
            onToggleSource={() => setSourceOpen((v) => !v)}
            onAddFiles={addFiles}
            entry={ws.entry}
            entrySource={ws.files[ws.entry] ?? ""}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen(true)}
            errors={chart.errors}
            warnings={chart.warnings}
            canRun={apiNodeCount > 0}
            running={run.status === "running"}
            onRun={startRun}
            onStop={run.stop}
            onAddNode={createNode}
            dataOn={dataOn}
            onToggleData={() => setDataOn((v) => !v)}
          />

          {sel && selResolved && (
            <PropertyPanel
              sel={{ kind: sel.kind, id: selResolved.rawId }}
              doc={selResolved.doc}
              shiftLeft={sourceOpen ? SOURCE_W : 0}
              onClose={() => setSel(null)}
              onCommitNode={commitNode}
              onCommitEdgeLabel={commitEdgeLabel}
              onCommitEdgeNote={commitEdgeNote}
              nodeCode={selNodeCode}
              onCommitNodeCode={commitNodeCode}
              onRenameNode={renameSelected}
              onDelete={run.status === "running" ? undefined : deleteSelected}
              runStep={run.steps.find((st) => st.nodeId === selResolved.rawId)}
            />
          )}

          {sourceOpen && (
            <SourcePanel
              name={ws.entry}
              value={ws.files[ws.entry] ?? ""}
              onChange={setEntrySource}
              onClose={() => setSourceOpen(false)}
            />
          )}

          {/* Lifts clear of the run bar rather than hiding under it. */}
          <div style={{ position: "absolute", inset: 0, bottom: runBarH, pointerEvents: "none" }}>
            <div className="relative h-full w-full [&>*]:pointer-events-auto">
              <WalkthroughPanel nodes={chart.nodes} edges={chart.doc.edges} />
            </div>
          </div>

          {run.status !== "idle" && (
            <RunBar
              run={run}
              open={runBarOpen}
              onToggle={() => setRunBarOpen((o) => !o)}
              onSelectNode={(id) => setSel({ kind: "node", id })}
              selectedNodeId={sel?.kind === "node" ? sel.id : null}
              onClose={run.clear}
            />
          )}

          {pendingWire &&
            (() => {
              const node = chart.doc.nodes.find((n) => n.id === pendingWire.target);
              if (!node) return null;
              return (
                <DataWirePicker
                  name={pendingWire.name}
                  target={pendingWire.target}
                  at={pendingWire.at}
                  options={wireOptions(node.data, node.type, pendingWire.name)}
                  onPick={pickWire}
                  onClose={() => setPendingWire(null)}
                />
              );
            })()}

          {askingInputs && (
            <RunInputs
              names={askingInputs}
              onCancel={() => setAskingInputs(null)}
              onRun={(values) => {
                setAskingInputs(null);
                setRunBarOpen(true);
                run.start(chart.doc, values);
              }}
            />
          )}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
