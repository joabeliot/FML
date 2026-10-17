// Node sockets (FML-22's sibling, FML-20): the data flow that `{name}`
// references already describe, made visible.
//
// `capture.token` on one node and `{token}` typed into another are a wire —
// the engine resolves them identically however they got there. This module
// only *reads* that wiring out of a parsed doc; it never changes what a
// variable means (see src/fml/variables.ts).
//
//   output port   one per `capture.<name>` on a node
//   input port    one per distinct `{name}` a node references anywhere —
//                 a name used in both a header and the body is one port
//   wire          capturing node's output → consuming node's input, per name
//
// Variables (FML-27) are nodes too, on the canvas only: every `@vars` entry
// and every run-time input (a name nothing supplies) gets a variable node
// with one output port, and its wires run to the nodes that spend it. Those
// nodes never enter the .fml as nodes — editing one edits `@vars`.

import { resolveVariables, varsInValue, type FmlDoc } from "../fml/index.ts";

export type InputSource = "capture" | "ask" | "vars" | "input";

export interface InputPort {
  name: string;
  source: InputSource;
  /** The capturing node, for a `capture` source. */
  from?: string;
}

export interface NodePorts {
  inputs: InputPort[];
  outputs: string[];
}

export interface DataWire {
  id: string;
  source: string;
  target: string;
  name: string;
}

/** A variable node: an `@vars` default, or a value supplied when the flow runs. */
export interface VarDef {
  name: string;
  source: "vars" | "input";
  /** The `@vars` default; absent for a run-time input. */
  value?: string;
}

export interface DataGraph {
  ports: Map<string, NodePorts>;
  wires: DataWire[];
  vars: VarDef[];
}

/** Canvas ids for variable nodes — `:` can't appear in an FML id, so they never collide. */
export const varNodeId = (name: string): string => `var:${name}`;
export const isVarNodeId = (id: string): boolean => id.startsWith("var:");
export const varNameOf = (id: string): string => id.slice("var:".length);

/** Handle ids — distinct from the control-flow `s-*` / `t-*` handles. */
export const outHandle = (name: string): string => `d-out-${name}`;
export const inHandle = (name: string): string => `d-in-${name}`;
export const isDataHandle = (id: string | null | undefined): boolean => !!id && id.startsWith("d-");
export const nameOfHandle = (id: string): string => id.replace(/^d-(out|in)-/, "");

export function dataGraph(doc: FmlDoc): DataGraph {
  const resolved = resolveVariables(doc);
  const ports = new Map<string, NodePorts>();
  const wires: DataWire[] = [];
  const vars: VarDef[] = Object.entries(doc.vars).map(([name, value]) => ({ name, source: "vars", value }));

  for (const node of doc.nodes) {
    const outputs: string[] = [];
    const names: string[] = [];
    for (const [key, value] of Object.entries(node.data)) {
      if (key.startsWith("capture.") || key.startsWith("ask.")) {
        // An ask (FML-26) supplies its name like a capture does — a person types it.
        const name = key.slice(key.indexOf(".") + 1);
        if (name && !outputs.includes(name)) outputs.push(name);
        continue; // a capture's value is a response path, not a reference
      }
      for (const name of varsInValue(value)) if (!names.includes(name)) names.push(name);
    }

    const inputs: InputPort[] = names.map((name) => {
      const r = resolved.get(name);
      if (!r) return { name, source: "input" };
      if (r.source === "vars") return { name, source: "vars" };
      return { name, source: r.source, ...(r.capturedBy ? { from: r.capturedBy } : {}) };
    });

    for (const input of inputs) {
      if (input.source !== "capture" && input.source !== "ask") {
        if (input.source === "input" && !vars.some((v) => v.name === input.name)) vars.push({ name: input.name, source: "input" });
        wires.push({ id: `data_${varNodeId(input.name)}_${node.id}_${input.name}`, source: varNodeId(input.name), target: node.id, name: input.name });
        continue;
      }
      // A node spending a value it captured itself (e.g. an assert on its own
      // capture) has nothing to draw between two places.
      if (!input.from || input.from === node.id) continue;
      wires.push({
        id: `data_${input.from}_${node.id}_${input.name}`,
        source: input.from,
        target: node.id,
        name: input.name,
      });
    }

    if (inputs.length > 0 || outputs.length > 0) ports.set(node.id, { inputs, outputs });
  }

  for (const v of vars) ports.set(varNodeId(v.name), { inputs: [], outputs: [v.name] });
  return { ports, wires, vars };
}

/**
 * The part of the graph to draw. Ports always show (FML-27: you connect to
 * them, so they have to be there to aim at); wires are everything with the
 * data layer on, otherwise only the selected node's, so selecting a node
 * shows where its values come from and go without the canvas filling up.
 */
export function visibleDataGraph(graph: DataGraph, allOn: boolean, selected: string | null): DataGraph {
  if (allOn) return graph;
  const wires = selected ? graph.wires.filter((w) => w.source === selected || w.target === selected) : [];
  return { ports: graph.ports, wires, vars: graph.vars };
}

/** Keys a `{name}` can be appended to — not the ones whose value isn't free text. */
const NOT_APPENDABLE = /^(capture\.|label$|method$|expect$)/;

export interface WireOption {
  /** What the menu shows. */
  label: string;
  /** The key written. */
  key: string;
  /** Its value after the edit. */
  value: string;
}

/**
 * Where dropping a `{name}` wire onto a node can put it — the menu the
 * canvas shows. Existing free-text fields get it appended (how a person
 * would type it); an `api` node also gets the two usual new homes for a
 * value: `auth: bearer {name}` and `query.<name>`.
 */
export function wireOptions(data: Record<string, string>, type: string, name: string): WireOption[] {
  const ref = `{${name}}`;
  const out: WireOption[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (NOT_APPENDABLE.test(key) || value.includes(ref)) continue;
    const v = value.trim();
    // In a path or url the value is a segment, not a word.
    const joined = key === "path" || key === "url" ? `${v.replace(/\/+$/, "")}/${ref}` : `${v} ${ref}`;
    out.push({ label: `${key}: …${key === "path" || key === "url" ? "/" : ""}${ref}`, key, value: v === "" ? ref : joined });
  }
  if (type === "api") {
    if (data.auth === undefined) out.push({ label: `auth: bearer ${ref}`, key: "auth", value: `bearer ${ref}` });
    const q = `query.${name}`;
    if (data[q] === undefined) out.push({ label: `${q}: ${ref}`, key: q, value: ref });
  }
  return out;
}
