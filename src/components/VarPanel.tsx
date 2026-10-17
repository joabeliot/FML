import { useEffect, useState } from "react";
import type { VarDef } from "../lib/dataWires.ts";

interface Props {
  v: VarDef;
  /** Nodes that spend `{name}`. */
  usedBy: string[];
  shiftLeft: number;
  onClose: () => void;
  /** Rename the variable and every `{name}`; false when the name is taken or invalid. */
  onRename: (to: string) => boolean;
  onValue: (value: string) => void;
  onDelete: () => void;
  onSelectNode: (id: string) => void;
}

const label = "font-mono text-[10px] uppercase tracking-[0.08em] text-ink-mute";
const field =
  "mt-1 w-full rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none focus:border-accent/60";

/** The property panel for a variable node (FML-27): it edits `@vars`, not a node. */
export function VarPanel(props: Props) {
  const { v } = props;
  const [name, setName] = useState(v.name);
  const [value, setValue] = useState(v.value ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => {
    setName(v.name);
    setValue(v.value ?? "");
    setNameError(null);
  }, [v.name, v.value]);

  const commitName = () => {
    if (name === v.name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return setNameError("letters, digits and _, not starting with a digit");
    if (!props.onRename(name)) setNameError("that name is already used");
  };
  const commitValue = () => {
    if (value !== (v.value ?? "") || v.source === "input") props.onValue(value);
  };

  return (
    <div className="absolute top-0 z-10 flex h-full w-[280px] flex-col border-l border-line bg-surface" style={{ right: props.shiftLeft }}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="font-mono text-[11px] text-[var(--color-data)]">{"{}"}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{v.name}</span>
        <button className="rounded px-1.5 text-[11px] text-ink-mute hover:text-danger" onClick={props.onDelete} title="Remove from @vars">
          Delete
        </button>
        <button className="rounded px-1.5 text-[13px] leading-none text-ink-mute hover:bg-white/10 hover:text-ink" onClick={props.onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        <label className="block">
          <span className={label}>name</span>
          <input
            className={field}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            onBlur={commitName}
            onKeyDown={(e) => e.key === "Enter" && commitName()}
          />
          {nameError && <span className="mt-1 block text-[10.5px] text-danger">{nameError}</span>}
          <span className="mt-1 block text-[10.5px] text-ink-mute">Renaming rewrites every {`{${v.name}}`} in this doc.</span>
        </label>

        <label className="block">
          <span className={label}>value</span>
          <input
            className={field}
            value={value}
            placeholder={v.source === "input" ? "no default: asked when the flow runs" : ""}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commitValue}
            onKeyDown={(e) => e.key === "Enter" && commitValue()}
          />
          <span className="mt-1 block text-[10.5px] text-ink-mute">
            {v.source === "input"
              ? "Nothing in the file supplies it, so a run asks for it. Giving it a value adds it to @vars."
              : "The @vars default. A run can still override it (--var, or the run dialog)."}
          </span>
        </label>

        <div>
          <div className={label}>used by</div>
          {props.usedBy.length === 0 ? (
            <p className="mt-1 text-[11px] text-ink-mute">Nothing yet. Drag its port onto a node.</p>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {props.usedBy.map((id) => (
                <button
                  key={id}
                  className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-ink hover:border-line-strong"
                  onClick={() => props.onSelectNode(id)}
                >
                  {id}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
