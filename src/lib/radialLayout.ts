// Skill-tree layout for roadmaps (FML-28).
//
// Like a game's talent tree: roots sit at the centre and every node is
// placed one grid step from its parent in one of the eight compass
// directions, so lines run horizontal, vertical or at 45°. A node grows
// outward — away from the centre, in its branch's direction — and takes the
// nearest free cell to that heading, stepping further out when the near
// ones are taken. The tree used for placement links each node to its
// deepest prerequisite; other dependencies are still drawn, they just don't
// steer placement.
//
// Pure — no React, no DOM — so it's testable on its own.

export interface RadialInput {
  ids: string[];
  /** `source -> target`: target depends on source. */
  edges: Array<{ source: string; target: string }>;
  /** Siblings are ordered by this (e.g. area), so a category stays together. */
  groupOf?: (id: string) => string;
}

export interface RadialPos {
  /** Centre of the tile, in pixels. */
  x: number;
  y: number;
  depth: number;
  /** Grid cell. */
  gx: number;
  gy: number;
}

/** One grid step, in pixels. */
export const GRID = 124;

const DIRS = Array.from({ length: 8 }, (_, k) => {
  const a = (k * Math.PI) / 4;
  return { a, dx: Math.round(Math.cos(a)), dy: Math.round(Math.sin(a)) };
});

const angleDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
};

export function radialLayout({ ids, edges, groupOf = () => "" }: RadialInput): Map<string, RadialPos> {
  const known = new Set(ids);
  const deps = new Map<string, string[]>();
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target) || e.source === e.target) continue;
    deps.set(e.target, [...(deps.get(e.target) ?? []), e.source]);
  }

  // Depth = longest path from a root; a cycle (an RML error, flagged
  // elsewhere) is cut rather than looped on.
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const d = depth.get(id);
    if (d !== undefined) return d;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const v = Math.max(-1, ...(deps.get(id) ?? []).map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, v);
    return v;
  };
  for (const id of ids) depthOf(id);

  // Spanning tree: parent = deepest prerequisite (first on a tie).
  const ROOT = "\u0000root";
  const children = new Map<string, string[]>([[ROOT, []]]);
  for (const id of ids) {
    const ds = (deps.get(id) ?? []).filter((d) => depth.get(d)! < depth.get(id)!);
    const parent = ds.length ? ds.reduce((a, b) => (depth.get(b)! > depth.get(a)! ? b : a)) : ROOT;
    children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const size = new Map<string, number>();
  const sizeOf = (id: string): number => {
    const n = 1 + (children.get(id) ?? []).reduce((s, k) => s + sizeOf(k), 0);
    size.set(id, n);
    return n;
  };
  sizeOf(ROOT);
  // Same area together; within it, bigger branches first so they get the
  // straightest headings.
  const order = (list: string[]) =>
    [...list].sort((a, b) => groupOf(a).localeCompare(groupOf(b)) || size.get(b)! - size.get(a)! || ids.indexOf(a) - ids.indexOf(b));

  const taken = new Set<string>();
  const cell = new Map<string, { gx: number; gy: number }>();
  const key = (x: number, y: number) => `${x},${y}`;

  // A single root is the centre itself; several fan out around it.
  const roots = order(children.get(ROOT)!);
  const queue: string[] = [];
  const placeKids = (at: { gx: number; gy: number }, heading: number | null, kids: string[]) => {
    kids.forEach((kid, k) => {
      // Spread siblings around the heading (or the whole circle at the centre).
      const want = heading === null ? -Math.PI / 2 + (k * 2 * Math.PI) / kids.length : heading + (k - (kids.length - 1) / 2) * (Math.PI / 4);
      let best: { gx: number; gy: number; cost: number } | null = null;
      for (let dist = 1; dist <= 8; dist++) {
        for (const d of DIRS) {
          const gx = at.gx + d.dx * dist;
          const gy = at.gy + d.dy * dist;
          if (taken.has(key(gx, gy))) continue;
          const inward = Math.hypot(gx, gy) < Math.hypot(at.gx, at.gy) ? 3 : 0;
          const cost = angleDiff(d.a, want) / (Math.PI / 4) + (dist - 1) * 1.6 + inward;
          if (!best || cost < best.cost) best = { gx, gy, cost };
        }
        if (best && best.cost < dist * 1.6) break;
      }
      const c = best ?? { gx: at.gx, gy: at.gy + 99 };
      taken.add(key(c.gx, c.gy));
      cell.set(kid, { gx: c.gx, gy: c.gy });
      queue.push(kid);
    });
  };
  if (roots.length === 1) {
    taken.add(key(0, 0));
    cell.set(roots[0]!, { gx: 0, gy: 0 });
    queue.push(roots[0]!);
  } else {
    taken.add(key(0, 0));
    placeKids({ gx: 0, gy: 0 }, null, roots);
  }

  // Breadth-first, so each ring claims its space before the next one out.
  while (queue.length) {
    const id = queue.shift()!;
    const at = cell.get(id)!;
    const heading = at.gx === 0 && at.gy === 0 ? null : Math.atan2(at.gy, at.gx);
    placeKids(at, heading, order(children.get(id) ?? []));
  }

  const out = new Map<string, RadialPos>();
  for (const id of ids) {
    const c = cell.get(id) ?? { gx: 0, gy: 0 };
    out.set(id, { x: c.gx * GRID, y: c.gy * GRID, depth: depth.get(id)!, gx: c.gx, gy: c.gy });
  }
  return out;
}
