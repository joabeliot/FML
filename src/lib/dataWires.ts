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
// A name supplied by `@vars` has an input port but no wire (its value is in
// the file, not produced by a node); a name nothing supplies is a run-time
// input, also wire-less, and flagged as such on the port.

import { resolveVariables, varsInValue, type FmlDoc } from "../fml/index.ts";

export type InputSource = "capture" | "vars" | "input";

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

export interface DataGraph {
  ports: Map<string, NodePorts>;
  wires: DataWire[];
}

/** Handle ids — distinct from the control-flow `s-*` / `t-*` handles. */
export const outHandle = (name: string): string => `d-out-${name}`;
export const inHandle = (name: string): string => `d-in-${name}`;
export const isDataHandle = (id: string | null | undefined): boolean => !!id && id.startsWith("d-");
export const nameOfHandle = (id: string): string => id.replace(/^d-(out|in)-/, "");

export function dataGraph(doc: FmlDoc): DataGraph {
  const resolved = resolveVariables(doc);
  const ports = new Map<string, NodePorts>();
  const wires: DataWire[] = [];

  for (const node of doc.nodes) {
    const outputs: string[] = [];
    const names: string[] = [];
    for (const [key, value] of Object.entries(node.data)) {
      if (key.startsWith("capture.")) {
        const name = key.slice("capture.".length);
        if (name && !outputs.includes(name)) outputs.push(name);
        continue; // a capture's value is a response path, not a reference
      }
      for (const name of varsInValue(value)) if (!names.includes(name)) names.push(name);
    }

    const inputs: InputPort[] = names.map((name) => {
      const r = resolved.get(name);
      if (!r) return { name, source: "input" };
      if (r.source === "vars") return { name, source: "vars" };
      return { name, source: "capture", ...(r.capturedBy ? { from: r.capturedBy } : {}) };
    });

    for (const input of inputs) {
      // A node spending a value it captured itself (e.g. an assert on its own
      // capture) has nothing to draw between two places.
      if (input.source !== "capture" || !input.from || input.from === node.id) continue;
      wires.push({
        id: `data_${input.from}_${node.id}_${input.name}`,
        source: input.from,
        target: node.id,
        name: input.name,
      });
    }

    if (inputs.length > 0 || outputs.length > 0) ports.set(node.id, { inputs, outputs });
  }

  return { ports, wires };
}

/**
 * The part of the graph to draw: everything when the data layer is on,
 * otherwise only the selected node's wires (and the ports at either end of
 * them, plus its own) — so selecting a node always shows where its values
 * come from and go, without the whole canvas filling with wires.
 */
export function visibleDataGraph(graph: DataGraph, allOn: boolean, selected: string | null): DataGraph {
  if (allOn) return graph;
  if (!selected) return { ports: new Map(), wires: [] };

  const wires = graph.wires.filter((w) => w.source === selected || w.target === selected);
  const ports = new Map<string, NodePorts>();
  const own = graph.ports.get(selected);
  if (own) ports.set(selected, own);
  for (const w of wires) {
    const other = w.source === selected ? w.target : w.source;
    const full = graph.ports.get(other);
    if (!full) continue;
    const prev = ports.get(other) ?? { inputs: [], outputs: [] };
    if (w.target === other) {
      const input = full.inputs.find((i) => i.name === w.name);
      if (input && !prev.inputs.some((i) => i.name === w.name)) prev.inputs.push(input);
    } else if (!prev.outputs.includes(w.name)) {
      prev.outputs.push(w.name);
    }
    ports.set(other, prev);
  }
  return { ports, wires };
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
