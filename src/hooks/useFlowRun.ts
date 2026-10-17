import { useCallback, useRef, useState } from "react";
import { requiredInputs, runFlow, type AskRequest, type FmlDoc, type RunResult, type StepResult } from "../fml/index.ts";
import { browserTransport } from "../lib/httpTransport.ts";

/** What one node is doing right now, as far as the canvas is concerned. */
export type NodeRunState = "running" | "passed" | "failed" | "skipped";

/**
 * How long each beat is held so a run is watchable. Real requests come back in
 * anywhere from 5ms to a second; without a floor, a passing flow is a single
 * frame of green and you learn nothing from watching it.
 *
 * These are *floors*, not delays added to the request — the engine awaits the
 * UI's callbacks, so a slow request simply blows through its floor. Nothing
 * here inflates a reported duration; those come from the transport.
 */
const BEAT = { start: 220, settle: 260, edge: 380 };

export type RunSpeed = "watch" | "fast";

/**
 * Where the camera should be looking. `ids` empty means "the whole graph".
 * `nonce` makes each request distinct so focusing the same node twice in a row
 * still moves the camera.
 */
export interface FocusRequest {
  ids: string[];
  nonce: number;
}

export interface FlowRun {
  status: "idle" | "running" | "done";
  /** null until a run finishes. */
  ok: boolean | null;
  steps: StepResult[];
  nodeState: Map<string, NodeRunState>;
  /** The edge the run is travelling along this instant — drives the pulse. */
  activeEdge: string | null;
  /** Every edge the run has actually followed. */
  takenEdges: Set<string>;
  /**
   * Every node the run reached, `page`s included. Kept apart from `nodeState`
   * because "the run went through here" and "this assertion passed" are
   * different facts — a page node is visited but never passes anything.
   */
  visited: Set<string>;
  /**
   * What the canvas should frame right now — the node being called, or both
   * ends of the edge a request is travelling. Only set in `watch`: at full
   * speed the camera would just thrash.
   */
  focus: FocusRequest | null;
  /** A question the run is waiting on a person for (FML-26), or null. */
  asking: AskRequest | null;
  /** Answer it — the value (`""` to carry on past a pause), or null to stop the run. */
  answer: (value: string | null) => void;
  /** The live variable store, so captures can be watched filling in. */
  vars: Record<string, string>;
  result: RunResult | null;
  speed: RunSpeed;
  setSpeed: (s: RunSpeed) => void;
  /** Names this doc can't supply — ask for these before starting. */
  inputsNeeded: (doc: FmlDoc) => string[];
  start: (doc: FmlDoc, inputs: Record<string, string>) => void;
  stop: () => void;
  clear: () => void;
}

const wait = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

/**
 * Drives a run and exposes it as something the canvas can render.
 *
 * The engine stays pure: it has no idea any of this is being watched. It just
 * awaits the callbacks below, and this hook holds them open long enough for a
 * person to follow what happened — request in flight, result, then a pulse
 * travelling the edge that was chosen.
 */
export function useFlowRun(): FlowRun {
  const [status, setStatus] = useState<FlowRun["status"]>("idle");
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [nodeState, setNodeState] = useState<Map<string, NodeRunState>>(new Map());
  const [activeEdge, setActiveEdge] = useState<string | null>(null);
  const [takenEdges, setTakenEdges] = useState<Set<string>>(new Set());
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const focusNonce = useRef(0);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [result, setResult] = useState<RunResult | null>(null);
  const [speed, setSpeed] = useState<RunSpeed>("watch");
  const [asking, setAsking] = useState<AskRequest | null>(null);
  const answerRef = useRef<((value: string | null) => void) | null>(null);
  const answer = useCallback((value: string | null) => answerRef.current?.(value), []);

  const abort = useRef<AbortController | null>(null);
  // Read inside the engine's callbacks, which are created once per run — a ref
  // so flipping the speed toggle mid-run takes effect immediately.
  const speedRef = useRef<RunSpeed>(speed);
  speedRef.current = speed;
  const beat = (ms: number) => wait(speedRef.current === "watch" ? ms : 0);
  /** Aim the camera, but only when there's a person watching it move. */
  const look = (ids: string[]) => {
    if (speedRef.current !== "watch") return;
    focusNonce.current += 1;
    setFocus({ ids, nonce: focusNonce.current });
  };

  const clear = useCallback(() => {
    setStatus("idle");
    setSteps([]);
    setNodeState(new Map());
    setActiveEdge(null);
    setTakenEdges(new Set());
    setVisited(new Set());
    setFocus(null);
    setVars({});
    setResult(null);
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort();
  }, []);

  const start = useCallback((doc: FmlDoc, inputs: Record<string, string>) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setStatus("running");
    setSteps([]);
    setNodeState(new Map());
    setActiveEdge(null);
    setTakenEdges(new Set());
    setVisited(new Set());
    setVars({ ...doc.vars, ...inputs });
    setResult(null);

    void (async () => {
      try {
        const run = await runFlow(doc, {
          transport: browserTransport,
          vars: inputs,
          signal: controller.signal,

          // `ask.<name>` / `pause` (FML-26): hold the run until the dialog answers.
          ask: (req, signal) =>
            new Promise<string | null>((resolve, reject) => {
              const onAbort = () => {
                settle();
                reject(new DOMException("stopped", "AbortError"));
              };
              const settle = () => {
                answerRef.current = null;
                setAsking(null);
                signal?.removeEventListener("abort", onAbort);
              };
              answerRef.current = (value) => {
                settle();
                if (value !== null && req.kind === "value") setVars((prev) => ({ ...prev, [req.name!]: value }));
                resolve(value);
              };
              signal?.addEventListener("abort", onAbort, { once: true });
              look([req.nodeId]);
              setAsking(req);
            }),

          onStepStart: async (node) => {
            // Settle on the node about to act — including a page/decision the
            // flow passes through, so the camera never skips a beat of the path.
            look([node.id]);
            if (node.type !== "api") return; // sends nothing, so no status
            setNodeState((prev) => new Map(prev).set(node.id, "running"));
            await beat(BEAT.start);
          },

          onStep: async (step) => {
            setSteps((prev) => [...prev, step]);
            setVisited((prev) => new Set(prev).add(step.nodeId));
            if (!step.passthrough) {
              setNodeState((prev) =>
                new Map(prev).set(step.nodeId, step.skipped ? "skipped" : step.ok ? "passed" : "failed"),
              );
              // Captures land in the store the instant they're read, so the
              // variables view fills in as you watch rather than at the end.
              if (step.captures.length > 0) {
                setVars((prev) => {
                  const next = { ...prev };
                  for (const c of step.captures) if (c.value !== undefined) next[c.name] = c.value;
                  return next;
                });
              }
              await beat(BEAT.settle);
            }
          },

          onEdge: async (edge) => {
            setTakenEdges((prev) => new Set(prev).add(edge.id));
            setActiveEdge(edge.id);
            // Frame both ends while the pulse crosses — you want to see where
            // it left and where it's going, not one node in isolation.
            look([edge.source, edge.target]);
            await beat(BEAT.edge);
            setActiveEdge(null);
          },
        });

        setResult(run);
        setVars(run.vars);
        setStatus("done");
        // Stay where the run ended rather than pulling back to the whole
        // graph. On a failure the last node *is* the thing you need to be
        // looking at, and on a short run a fit-all reads as "it zoomed out and
        // nothing happened". The fit-view control is one click away if the
        // overview is what you want.
        const last = run.steps[run.steps.length - 1];
        if (last) look([last.nodeId]);
      } catch {
        // runFlow itself doesn't throw for a failed request — that's a step
        // result. Reaching here means the run was aborted.
        setStatus("done");
      } finally {
        setActiveEdge(null);
      }
    })();
  }, []);

  return {
    status,
    ok: result ? result.ok : null,
    steps,
    nodeState,
    activeEdge,
    takenEdges,
    visited,
    focus,
    asking,
    answer,
    vars,
    result,
    speed,
    setSpeed,
    inputsNeeded: requiredInputs,
    start,
    stop,
    clear,
  };
}
