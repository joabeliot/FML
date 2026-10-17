import { Fragment, useEffect } from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import type { FmlFlowNode } from "../../types/chart.ts";
import { inHandle, outHandle, type NodePorts } from "../../lib/dataWires.ts";
import { UNTYPED } from "../../fml/index.ts";
import { kindColor, kindTag, TRACE_IN, TRACE_OUT } from "../../lib/nodeStyle.ts";
import { Glyph } from "../Glyph.tsx";

const SIDES = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
] as const;

/** Meta rows shown inline before the card starts collapsing them into a count. */
const META_LIMIT = 4;

/** Only render an image we can actually fetch from the browser. */
const RENDERABLE_IMAGE = /^(https?:|data:image\/)/i;

/**
 * One card renderer for every FML node type. The type drives the accent rail,
 * the glyph and the tag; `flow` additionally gets a stacked-card silhouette
 * because it is a portal into another doc, and an untyped node gets a dashed
 * border so an undeclared reference is visible at a glance.
 */
export function FmlNode({ id, data, selected }: NodeProps<FmlFlowNode>) {
  const { label, kind, meta, dir, order, traceRole, onBadge, expanded, onExpand, runState, ports } = data;

  // Data ports come and go (Data toggle, selection). React Flow only learns
  // about handles added after measuring when told — without this, a wire to
  // a freshly shown port has nowhere to attach.
  const updateNodeInternals = useUpdateNodeInternals();
  const portKey = ports ? `${ports.inputs.map((p) => p.name).join(",")}|${ports.outputs.join(",")}` : "";
  useEffect(() => updateNodeInternals(id), [id, portKey, updateNodeInternals]);
  const lr = dir === "LR";
  const primaryTarget = lr ? "left" : "top";
  const primarySource = lr ? "right" : "bottom";

  const accent = kindColor(kind);
  const untyped = kind === UNTYPED;
  const portal = kind === "flow";

  const image = meta.image && RENDERABLE_IMAGE.test(meta.image) ? meta.image : undefined;
  const rows = Object.entries(meta).filter(([k]) => !(image && k === "image"));
  const shown = rows.slice(0, META_LIMIT);
  const hidden = rows.length - shown.length;

  // How the badge reads during a run. `skipped` deliberately has no badge of
  // its own — a node the run never reached should recede, not shout.
  const runBadge =
    runState === "running"
      ? { glyph: "•", color: "var(--color-ink-dim)", title: "request in flight" }
      : runState === "passed"
        ? { glyph: "✓", color: "var(--color-api)", title: "passed" }
        : runState === "failed"
          ? { glyph: "✕", color: "var(--color-danger)", title: "failed" }
          : undefined;

  const handleClass = (visible: boolean) =>
    // The visible pair doubles as the drag-to-connect grip — a touch bigger
    // than a dot, and lit on hover so it reads as something you can pull.
    visible
      ? "!h-2 !w-2 !border-0 !bg-[#3d3d3d] transition-colors hover:!bg-[var(--color-accent)]"
      : "!h-1 !w-1 !bg-transparent !opacity-0";

  return (
    <div className="relative">
      {SIDES.map(([name, pos]) => (
        <Fragment key={name}>
          <Handle
            id={`t-${name}`}
            type="target"
            position={pos}
            className={handleClass(name === primaryTarget)}
          />
          <Handle
            id={`s-${name}`}
            type="source"
            position={pos}
            className={handleClass(name === primarySource)}
          />
        </Fragment>
      ))}

      {ports && <DataPorts ports={ports} />}

      {/* the "there is another doc behind this" silhouette */}
      {portal && (
        <div className="absolute inset-0 -translate-y-1.5 translate-x-1.5 rounded-xl border border-line bg-surface" />
      )}

      {/* prev / next tag — shown while another node's badge is traced. Same
          blue-in / orange-out colour as the connecting edge, so the tag and
          the line you followed to get here read as one thing. */}
      {(traceRole === "in" || traceRole === "out") && (
        <div
          className="absolute -left-2 -top-2.5 z-20 rounded-full border px-1.5 py-[1px] font-mono text-[9px] font-medium uppercase tracking-[0.06em]"
          style={{
            borderColor: `color-mix(in srgb, ${traceRole === "in" ? TRACE_IN : TRACE_OUT} 55%, transparent)`,
            background: "var(--color-elevated)",
            color: traceRole === "in" ? TRACE_IN : TRACE_OUT,
          }}
        >
          {traceRole === "in" ? "prev" : "next"}
        </div>
      )}

      {/* expand toggle — portals only. Unfolds the target doc inline as a
          bubble right under this card, or collapses it back. */}
      {portal && meta.doc && (
        <button
          type="button"
          title={expanded ? `Collapse "${meta.doc}"` : `Expand "${meta.doc}" inline`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onExpand?.(id);
          }}
          className="nodrag absolute -right-9 -top-2.5 z-20 flex h-[20px] w-[20px] cursor-pointer items-center justify-center rounded-full border border-line bg-elevated text-[10px] text-ink-dim transition-colors hover:border-line-strong hover:text-ink"
        >
          {expanded ? "▾" : "▸"}
        </button>
      )}

      {/* Step number — its place in the flow. Click it to trace what connects
          here. During a run the badge *is* the status: a step's position in the
          flow and its result are the same fact, so this stays one control
          instead of crowding the card with a second indicator. */}
      {typeof order === "number" && (
        <button
          type="button"
          title={runBadge ? runBadge.title : "Show what connects to this node"}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onBadge?.(id);
          }}
          className={`nodrag absolute -right-2.5 -top-2.5 z-20 flex h-[20px] min-w-[20px] cursor-pointer items-center justify-center rounded-full border px-1 font-mono text-[10px] font-semibold tabular-nums transition-transform hover:scale-110 ${
            runState === "running" ? "animate-pulse" : ""
          }`}
          style={
            runBadge
              ? { borderColor: runBadge.color, background: runBadge.color, color: "var(--color-bg)" }
              : traceRole === "self"
                ? { borderColor: accent, background: accent, color: "var(--color-bg)" }
                : {
                    borderColor: `color-mix(in srgb, ${accent} 45%, transparent)`,
                    background: "var(--color-elevated)",
                    color: `color-mix(in srgb, ${accent} 75%, var(--color-ink))`,
                  }
          }
        >
          {runBadge ? runBadge.glyph : order}
        </button>
      )}

      <div
        title={portal && meta.doc ? `Double-click to open "${meta.doc}"` : undefined}
        className={`relative flex min-w-[188px] max-w-[264px] overflow-hidden rounded-xl bg-surface-2 transition-[box-shadow,opacity] ${
          untyped ? "border border-dashed border-line-strong" : "border border-line"
        }`}
        style={
          runState === "running"
            ? {
                borderColor: "color-mix(in srgb, var(--color-ink-dim) 60%, transparent)",
                boxShadow: "0 0 0 3px color-mix(in srgb, var(--color-ink-dim) 22%, transparent), 0 6px 22px -6px rgba(0,0,0,0.65)",
              }
            : runState === "passed" || runState === "failed"
              ? {
                  borderColor: `color-mix(in srgb, ${runState === "passed" ? "var(--color-api)" : "var(--color-danger)"} 55%, transparent)`,
                  boxShadow: `0 0 0 1px color-mix(in srgb, ${runState === "passed" ? "var(--color-api)" : "var(--color-danger)"} 30%, transparent), 0 6px 22px -6px rgba(0,0,0,0.65)`,
                }
              : runState === "skipped"
                ? { boxShadow: "0 2px 14px -3px rgba(0,0,0,0.55)", opacity: 0.3 }
                : selected
            ? {
                borderColor: `color-mix(in srgb, ${accent} 55%, transparent)`,
                boxShadow: `0 0 0 1px color-mix(in srgb, ${accent} 35%, transparent), 0 6px 22px -6px rgba(0,0,0,0.65)`,
                opacity: traceRole === "dim" ? 0.25 : undefined,
              }
            : {
                boxShadow: "0 2px 14px -3px rgba(0,0,0,0.55)",
                opacity: traceRole === "dim" ? 0.25 : undefined,
              }
        }
      >
        {/* type rail */}
        <div className="w-[3px] shrink-0" style={{ background: accent, opacity: untyped ? 0.4 : 1 }} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 px-2.5 py-2">
            <span className="shrink-0" style={{ color: accent, opacity: untyped ? 0.55 : 1 }}>
              <Glyph kind={kind} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{label}</span>
            <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">
              {kindTag(kind)}
            </span>
          </div>

          {image && (
            <img
              src={image}
              alt=""
              className="h-24 w-full border-t border-line object-cover"
              draggable={false}
            />
          )}

          {shown.length > 0 && (
            <dl className="space-y-1 border-t border-line px-2.5 py-2 font-mono text-[11px] leading-relaxed">
              {shown.map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="shrink-0 text-ink-mute">{k}</dt>
                  <dd className="truncate text-ink-dim">{v}</dd>
                </div>
              ))}
              {hidden > 0 && (
                <div className="text-ink-mute/70">+{hidden} more</div>
              )}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

/** Vertical spot for port `i` of `n` along a side, as a CSS top. */
const portTop = (i: number, n: number): string => `${((i + 1) / (n + 1)) * 100}%`;

const PORT_TITLE: Record<string, string> = {
  capture: "captured by an earlier node",
  ask: "asked of a person mid-run",
  vars: "an @vars default — set in the file",
  input: "a run-time input — nothing in the file supplies it",
};

/**
 * Data sockets (FML-20): inputs down the left edge — one per `{name}` the
 * node spends — and outputs down the right — one per `capture.<name>`. They
 * sit on the sides because control flow owns top and bottom, and they're
 * dashed-wire orange so the two kinds of connection never read as one.
 * Drag from an output onto another node to use the value there.
 */
function DataPorts({ ports }: { ports: NodePorts }) {
  const dot = "!h-2 !w-2 !min-h-0 !min-w-0 !border-[1.5px]";
  return (
    <>
      {ports.inputs.map((p, i) => (
        <Handle
          key={`in-${p.name}`}
          id={inHandle(p.name)}
          type="target"
          position={Position.Left}
          isConnectableStart={false}
          className={dot}
          style={{
            top: portTop(i, ports.inputs.length),
            borderColor: p.source === "input" ? "var(--color-danger)" : "var(--color-data)",
            background: p.source === "capture" || p.source === "ask" ? "var(--color-data)" : "var(--color-bg)",
          }}
          title={`{${p.name}} — ${PORT_TITLE[p.source]}${p.from ? ` (${p.from})` : ""}`}
        >
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[9.5px] text-[var(--color-data)]">
            {p.name}
          </span>
        </Handle>
      ))}
      {ports.outputs.map((name, i) => (
        <Handle
          key={`out-${name}`}
          id={outHandle(name)}
          type="source"
          position={Position.Right}
          className={`${dot} cursor-crosshair`}
          style={{
            top: portTop(i, ports.outputs.length),
            borderColor: "var(--color-data)",
            background: "var(--color-data)",
          }}
          title={`capture.${name} — drag onto another node to use {${name}} there`}
        >
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[9.5px] text-[var(--color-data)]">
            {name}
          </span>
        </Handle>
      ))}
    </>
  );
}
