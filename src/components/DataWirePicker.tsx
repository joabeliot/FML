import { useEffect, useRef, useState } from "react";
import type { WireOption } from "../lib/dataWires.ts";

interface Props {
  /** The variable being wired, without braces. */
  name: string;
  /** The node it was dropped on. */
  target: string;
  /** Screen point of the drop — the menu opens there. */
  at: { x: number; y: number };
  options: WireOption[];
  onPick: (key: string, value: string) => void;
  onClose: () => void;
}

const KEY_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Where should `{name}` go on the node it was dropped on? A field is free
 * text, so a wire doesn't land in a typed slot — it's appended to a field you
 * pick (exactly what typing it by hand would do), or starts a new one.
 */
export function DataWirePicker({ name, target, at, options, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const ref_ = `{${name}}`;
  const validKey = KEY_RE.test(newKey) && !newKey.startsWith("capture.");

  return (
    <div
      ref={ref}
      className="fixed z-30 w-[240px] rounded-xl border border-line bg-surface p-1 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.7)]"
      style={{ left: Math.min(at.x + 8, window.innerWidth - 252), top: Math.min(at.y + 8, window.innerHeight - 260) }}
    >
      <div className="px-2 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-mute">
        use <span className="normal-case text-[var(--color-data)]">{ref_}</span> in{" "}
        <span className="normal-case text-ink-dim">{target}</span>
      </div>
      {options.map((o) => (
        <button
          key={o.key}
          className="block w-full truncate rounded-lg px-2 py-1.5 text-left font-mono text-[11px] text-ink transition-colors hover:bg-white/[0.06]"
          onClick={() => onPick(o.key, o.value)}
          title={`${o.key}: ${o.value}`}
        >
          {o.label}
        </button>
      ))}
      <form
        className="mt-1 flex gap-1 border-t border-line px-1 pt-1.5 pb-0.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (validKey) onPick(newKey, ref_);
        }}
      >
        <input
          autoFocus={options.length === 0}
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-ink-mute focus:border-accent/60"
          placeholder="new key, e.g. header.X-Token"
          value={newKey}
          spellCheck={false}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button
          type="submit"
          disabled={!validKey}
          className="rounded-md px-2 text-[11px] font-medium text-ink-dim transition-colors enabled:hover:bg-white/[0.06] enabled:hover:text-ink disabled:opacity-40"
        >
          Add
        </button>
      </form>
    </div>
  );
}
