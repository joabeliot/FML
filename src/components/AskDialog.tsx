import { useEffect, useRef, useState } from "react";
import type { AskRequest } from "../fml/index.ts";

interface Props {
  req: AskRequest;
  /** The value (`""` past a pause), or null to stop the run. */
  onAnswer: (value: string | null) => void;
}

/**
 * A run waiting on a person (FML-26): `ask.<name>` wants a value, `pause`
 * wants a go-ahead. Unlike RunInputs this appears mid-run, so clicking the
 * backdrop does nothing — stopping the run is a choice, not a misclick.
 * Answers live in the run's memory only, same as RunInputs.
 */
export function AskDialog({ req, onAnswer }: Props) {
  const [value, setValue] = useState("");
  const focus = useRef<HTMLInputElement & HTMLButtonElement>(null);

  useEffect(() => {
    setValue("");
    focus.current?.focus();
  }, [req]);

  const isValue = req.kind === "value";
  const submit = () => onAnswer(isValue ? value : "");

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-label="The run is waiting for you"
        className="w-[380px] rounded-xl border border-warn/40 bg-surface p-4 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onAnswer(null);
        }}
      >
        <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-warn">
          {isValue ? "the run needs a value" : "paused"} · {req.nodeId}
        </div>
        <h2 className="mt-1.5 text-[13px] font-medium leading-snug text-ink">{req.prompt}</h2>

        {isValue && (
          <label className="mt-3 flex flex-col gap-1">
            <span className="font-mono text-[10px] text-ink-mute">{`{${req.name}}`}</span>
            <input
              ref={focus}
              type={req.secret ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-line-strong"
            />
          </label>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => onAnswer(null)}
            className="rounded-md px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:text-danger"
          >
            Stop run
          </button>
          <button
            ref={isValue ? undefined : focus}
            onClick={submit}
            className="rounded-md bg-elevated px-3 py-1.5 text-[12px] text-ink ring-1 ring-line-strong transition-colors hover:bg-surface-2"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
