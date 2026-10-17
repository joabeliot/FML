// Usage: node src/lib/radialLayout.test.ts
import { radialLayout } from "./radialLayout.ts";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const dist = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

const cells = (pos: Map<string, { gx: number; gy: number }>) => [...pos.values()].map((p) => `${p.gx},${p.gy}`);
const cheb = (a: { gx: number; gy: number }, b: { gx: number; gy: number }) => Math.max(Math.abs(a.gx - b.gx), Math.abs(a.gy - b.gy));

// One root: it's the centre; children are one step away, in any of 8 directions.
{
  const pos = radialLayout({
    ids: ["root", "a", "b", "c", "a1", "a2"],
    edges: [
      { source: "root", target: "a" },
      { source: "root", target: "b" },
      { source: "root", target: "c" },
      { source: "a", target: "a1" },
      { source: "a", target: "a2" },
    ],
  });
  ok("a single root sits at the centre", pos.get("root")!.x === 0 && pos.get("root")!.y === 0);
  ok("children are one grid step from it", ["a", "b", "c"].every((k) => cheb(pos.get(k)!, pos.get("root")!) === 1));
  ok("so every line is horizontal, vertical or 45°", ["a1", "a2"].every((k) => {
    const dx = Math.abs(pos.get(k)!.gx - pos.get("a")!.gx);
    const dy = Math.abs(pos.get(k)!.gy - pos.get("a")!.gy);
    return dx === 0 || dy === 0 || dx === dy;
  }));
  ok("grandchildren grow outward", ["a1", "a2"].every((k) => dist(pos.get(k)!) > dist(pos.get("a")!)));
}

// Several roots fan out around an empty centre.
{
  const pos = radialLayout({ ids: ["x", "y"], edges: [] });
  ok("two roots are off-centre", dist(pos.get("x")!) > 0 && dist(pos.get("y")!) > 0);
  ok("and apart", gap(pos.get("x")!, pos.get("y")!) > 100);
}

// A node's depth is past its deepest prerequisite, not its first.
{
  const pos = radialLayout({
    ids: ["r", "p", "q", "m"],
    edges: [
      { source: "r", target: "p" },
      { source: "p", target: "q" },
      { source: "r", target: "m" },
      { source: "q", target: "m" },
    ],
  });
  ok("m is placed off q, its deepest prerequisite", pos.get("m")!.depth === 3 && cheb(pos.get("m")!, pos.get("q")!) === 1);
}

// Crowded parents push children further out; no two tiles share a cell.
{
  const ids = ["hub", ...Array.from({ length: 24 }, (_, i) => `n${i}`)];
  const pos = radialLayout({ ids, edges: ids.slice(1).map((t) => ({ source: "hub", target: t })) });
  ok("24 siblings get 24 distinct cells", new Set(cells(pos)).size === ids.length);
}

// The example roadmap: every tile has its own cell.
{
  const { parse } = await import("../fml/index.ts");
  const { RML_VOCABULARY } = await import("../rml/rml.ts");
  const fs = await import("node:fs");
  const doc = parse(fs.readFileSync("examples/roadmap.rml", "utf8"), { strict: true, vocabulary: RML_VOCABULARY }).doc;
  const pos = radialLayout({ ids: doc.nodes.map((n) => n.id), edges: doc.edges });
  ok("examples/roadmap.rml lays out with no overlaps", new Set(cells(pos)).size === doc.nodes.length);
}

// A cycle (an RML error) doesn't hang the layout.
{
  const pos = radialLayout({ ids: ["a", "b"], edges: [{ source: "a", target: "b" }, { source: "b", target: "a" }] });
  ok("a cycle still places every node", pos.size === 2);
}

// Siblings are grouped, so one area stays together.
{
  const area: Record<string, string> = { a: "x", b: "y", c: "x", d: "y" };
  const pos = radialLayout({
    ids: ["r", "a", "b", "c", "d"],
    edges: ["a", "b", "c", "d"].map((t) => ({ source: "r", target: t })),
    groupOf: (id) => area[id] ?? "",
  });
  const ang = (id: string) => (Math.atan2(pos.get(id)!.y, pos.get(id)!.x) + 2.5 * Math.PI) % (2 * Math.PI);
  const order = ["a", "b", "c", "d"].sort((p, q) => ang(p) - ang(q));
  ok("same-area siblings are neighbours", order.join("") === "acbd", order.join(""));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
