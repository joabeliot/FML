import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FmlFlowNode } from "../../types/chart.ts";
import { outHandle } from "../../lib/dataWires.ts";

/**
 * A variable on the canvas (FML-27): an `@vars` default, or a value the flow
 * asks for when it runs. One output port — drag it onto a card to put
 * `{name}` in a field, or onto an input port to point that reference here.
 * It isn't a node in the .fml; editing it edits `@vars`.
 */
export function VarNode({ data, selected }: NodeProps<FmlFlowNode>) {
  const name = data.label;
  const atRun = data.meta.source === "input";
  const value = data.meta.value ?? "";

  return (
    <div
      className={`relative flex min-w-[120px] max-w-[200px] items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[11px] ${
        atRun ? "border-dashed border-danger/70" : "border-[var(--color-data)]/70"
      } bg-surface ${selected ? "ring-2 ring-white/50" : ""}`}
      title={atRun ? `{${name}} — no default; supplied when the flow runs` : `{${name}} = ${value}`}
    >
      <span className="text-[var(--color-data)]">{`{${name}}`}</span>
      <span className="min-w-0 flex-1 truncate text-ink-mute">{atRun ? "at run" : value === "" ? "—" : value}</span>
      <Handle
        id={outHandle(name)}
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !min-h-0 !min-w-0 !border-[1.5px] cursor-crosshair"
        style={{ borderColor: "var(--color-data)", background: "var(--color-data)" }}
        title={`Drag onto a node to use {${name}} there`}
      />
    </div>
  );
}
