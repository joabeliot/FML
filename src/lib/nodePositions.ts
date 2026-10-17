// Manually-dragged node positions, persisted outside the `.fml` source.
//
// Auto-layout (dagre) computes positions fresh every time a doc is parsed —
// that's the whole point of FML, positions are never written into the text.
// But a dragged node should still be where you left it when you switch away
// and back, so drag positions live here instead: one localStorage blob, keyed
// by doc, read back and merged over the auto-layout result in `useFmlChart`.

import { fileKey } from "../types/workspace.ts";

const STORAGE_KEY = "protoarque_fml_positions";

interface Pos {
  x: number;
  y: number;
}

type Store = Record<string, Record<string, Pos>>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage full or unavailable — positions just won't stick this time */
  }
}

/** The same doc can live in different files (`@fof`) — key by both. */
export function docPositionKey(entryFile: string, doc: { source?: string; name: string }): string {
  const file = doc.source ? fileKey(doc.source) : entryFile;
  return `${file}::${doc.name}`;
}

/** Saved positions for one doc, by node id. Empty object if none are saved. */
export function getPositions(docKey: string): Record<string, Pos> {
  return readStore()[docKey] ?? {};
}

/** Save one or more dragged positions for a doc — called on drag stop, immediately. */
export function savePositions(docKey: string, positions: Record<string, Pos>): void {
  const store = readStore();
  store[docKey] = { ...store[docKey], ...positions };
  writeStore(store);
}

/** Carry a dragged position over to a node's new id after a rename. */
export function renamePosition(docKey: string, from: string, to: string): void {
  const store = readStore();
  const doc = store[docKey];
  const pos = doc?.[from];
  if (!doc || !pos) return;
  delete doc[from];
  doc[to] = pos;
  writeStore(store);
}
