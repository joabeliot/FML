import { useState } from "react";
import type { StepResult } from "../fml/index.ts";
import type { FlowRun } from "../hooks/useFlowRun.ts";

/** Height the open bar occupies, so fitView can keep nodes clear of it. */
export const RUN_BAR_H = 190;
export const RUN_BAR_COLLAPSED_H = 34;

const PASS = "var(--color-api)";
const FAIL = "var(--color-danger)";

function Mark({ step }: { step: StepResult }) {
  if (step.passthrough) return <span className="text-ink-mute/50">·</span>;
  return (
    <span style={{ color: step.ok ? PASS : FAIL }}>{step.ok ? "✔" : "✖"}</span>
  );
}

/** `POST https://api.test/auth/login` — the URL trimmed to its path when long. */
function requestLine(step: StepResult): string {
  if (!step.request) return "";
  const { method, url } = step.request;
  if (url.length <= 52) return `${method} ${url}`;
  try {
    const u = new URL(url);
    return `${method} ${u.pathname}${u.search}`;
  } catch {
    return `${method} ${url.slice(-48)}`;
  }
}

interface Props {
  run: FlowRun;
  open: boolean;
  onToggle: () => void;
  /** Selecting a step selects its node on the canvas. */
  onSelectNode: (id: string) => void;
  selectedNodeId: string | null;
  onClose: () => void;
}

/**
 * The run log: a full-width strip under the canvas, in the shape a test runner
 * output has — a verdict line, then every step in the order it happened.
 *
 * It's a second view of the same truth the canvas is showing, not the primary
 * one: the nodes carry pass/fail themselves. This is here for the linear read
 * ("what happened, in order") that a graph can't give you, and to click
 * straight to the node you care about.
 */
export function RunBar({ run, open, onToggle, onSelectNode, selectedNodeId, onClose }: Props) {
  const [copiedVar, setCopiedVar] = useState<string | null>(null);
  const copyVar = async (name: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedVar(name);
      setTimeout(() => setCopiedVar((c) => (c === name ? null : c)), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const requests = run.steps.filter((s) => !s.passthrough);
  const total = requests.reduce((ms, s) => ms + (s.durationMs ?? 0), 0);
  const failed = run.steps.find((s) => !s.ok);

  const verdict =
    run.status === "running"
      ? { text: "RUNNING", color: "var(--color-ink-dim)" }
      : run.ok === null
        ? { text: "—", color: "var(--color-ink-mute)" }
        : run.ok
          ? { text: "PASS", color: PASS }
          : { text: "FAIL", color: FAIL };

  const captured = Object.entries(run.vars);

  const res = run.result;
  const stopNote =
    !res || res.stoppedBecause === "end"
      ? null
      : res.stoppedBecause === "unmodelled"
        ? `${res.ambiguousAt} returned ${res.unmodelledStatus} and no edge leaves it for that status — draw a -${res.unmodelledStatus}> branch to carry on`
        : res.stoppedBecause === "ambiguous"
          ? `${res.ambiguousAt} has several outgoing edges and no status to choose between them`
          : res.stoppedBecause === "maxSteps"
            ? "hit the step limit — the flow probably loops"
            : res.stoppedBecause === "aborted"
              ? "stopped"
              : "stopped at the first failure";

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur-md"
      style={{ height: open ? RUN_BAR_H : RUN_BAR_COLLAPSED_H }}
    >
      {/* verdict bar */}
      <div className="flex h-[34px] items-center gap-3 px-3">
        <button
          onClick={onToggle}
          title={open ? "Minimise" : "Expand"}
          className="font-mono text-[10px] leading-none text-ink-mute transition-colors hover:text-ink"
        >
          {open ? "▾" : "▸"}
        </button>

        <span
          className="font-mono text-[11px] font-semibold tracking-[0.08em]"
          style={{ color: verdict.color }}
        >
          {verdict.text}
        </span>

        {run.status === "running" && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-dim" />
        )}

        <span className="font-mono text-[10px] text-ink-mute">
          {requests.length} request{requests.length === 1 ? "" : "s"}
          {total > 0 && ` · ${total}ms`}
        </span>

        {/* Say what actually happened, not the enum name. A run that stops
            early is usually a gap in the diagram, and the person reading this
            needs to know which gap. */}
        {stopNote && (
          <span className="min-w-0 shrink-[2] truncate font-mono text-[10px] text-ink-dim" title={stopNote}>
            {stopNote}
          </span>
        )}

        {failed?.error && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px]" style={{ color: FAIL }}>
            {failed.error}
          </span>
        )}
        {!failed?.error && <span className="flex-1" />}

        {/* Real requests are often too fast to see. "Watch" holds each beat
            long enough to follow; it never changes a reported duration. */}
        <div className="flex items-center overflow-hidden rounded-md border border-line">
          {(["watch", "fast"] as const).map((s) => (
            <button
              key={s}
              onClick={() => run.setSpeed(s)}
              title={s === "watch" ? "Pace the run so you can follow it" : "Full speed"}
              className={`px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.06em] transition-colors ${
                run.speed === s ? "bg-elevated text-ink" : "text-ink-mute hover:text-ink-dim"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <button
          onClick={onClose}
          title="Clear this run"
          className="font-mono text-[11px] leading-none text-ink-mute transition-colors hover:text-ink"
        >
          ✕
        </button>
      </div>

      {open && (
        <div className="flex h-[calc(100%-34px)] border-t border-line">
          {/* steps, in the order they happened */}
          <div className="min-w-0 flex-1 overflow-auto px-2 py-1.5">
            {run.steps.length === 0 && (
              <p className="px-1 py-2 font-mono text-[10px] text-ink-mute">
                {run.status === "running" ? "starting…" : "nothing ran"}
              </p>
            )}
            {run.steps.map((step, i) => (
              <button
                key={`${step.nodeId}-${i}`}
                onClick={() => onSelectNode(step.nodeId)}
                className={`flex w-full items-baseline gap-2 rounded px-1.5 py-[3px] text-left font-mono text-[10.5px] transition-colors hover:bg-elevated ${
                  selectedNodeId === step.nodeId ? "bg-elevated" : ""
                }`}
              >
                <Mark step={step} />
                <span className="shrink-0 text-ink">{step.nodeId}</span>
                <span className="min-w-0 flex-1 truncate text-ink-mute">{requestLine(step)}</span>
                {step.response && (
                  <span
                    className="shrink-0 tabular-nums"
                    style={{ color: step.ok ? "var(--color-ink-dim)" : FAIL }}
                  >
                    {step.response.status}
                  </span>
                )}
                {step.durationMs !== undefined && !step.passthrough && (
                  <span className="shrink-0 tabular-nums text-ink-mute/70">{step.durationMs}ms</span>
                )}
              </button>
            ))}
          </div>

          {/* the live variable store — watch captures fill in */}
          <div className="w-[240px] shrink-0 overflow-auto border-l border-line px-2 py-1.5">
            <div className="px-1 pb-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">
              Variables
            </div>
            {captured.length === 0 && (
              <p className="px-1 font-mono text-[10px] text-ink-mute/70">none yet</p>
            )}
            {captured.map(([name, value]) => (
              <div key={name} className="flex items-center gap-2 px-1 py-[2px] font-mono text-[10px]">
                <span className="shrink-0 text-ink-dim">{name}</span>
                <button
                  onClick={() => copyVar(name, value)}
                  title={copiedVar === name ? "Copied" : `Click to copy: ${value}`}
                  className="min-w-0 flex-1 truncate text-left transition-colors hover:text-ink"
                  style={{ color: copiedVar === name ? PASS : "var(--color-ink-mute)" }}
                >
                  {copiedVar === name ? "copied" : value}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
