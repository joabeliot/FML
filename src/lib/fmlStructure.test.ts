// Usage: node src/lib/fmlStructure.test.ts
import { readdirSync, readFileSync } from "node:fs";
import { parse, type FmlDoc } from "../fml/index.ts";
import { addEdge, addNode, deleteEdge, deleteNode, renameNode, safeLabel, uniqueNodeId } from "./fmlStructure.ts";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: string) => {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const eq = <T,>(name: string, actual: T, expected: T) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `got ${a}, want ${e}`);
};

const docOf = (src: string, name = "main"): FmlDoc => {
  const res = parse(src, { strict: false });
  return res.file.docs.find((d) => d.name === name) ?? res.doc;
};
const errorsOf = (src: string): number => parse(src, { strict: false }).errors.length;
const edgeList = (d: FmlDoc): string[] => d.edges.map((e) => `${e.source}-${e.label}>${e.target}`);
const nodeList = (d: FmlDoc): string[] => d.nodes.map((n) => `${n.id}=${n.type}`);

const SRC = `# header comment
@meta
  title: T

@nodes
  Login   = page   # the entry
  auth    = api
  Home    = page
  Denied  = page

@node auth {
  method: POST
  path: /login
}

@flow
  Login -tap login> auth   # tapping
  auth:
    -200> Home {
      note: happy path
    }
    -401> Denied
  Denied -retry> Login
`;

// 1. addNode -----------------------------------------------------------------
{
  const out = addNode(SRC, "main", "Settings", "page");
  ok("declared at the end of @nodes", out.includes("  Denied  = page\n  Settings = page\n"));
  eq("node exists with its type", nodeList(docOf(out)).includes("Settings=page"), true);
  eq("nothing else changed", out.replace("  Settings = page\n", ""), SRC);
  eq("a taken id is a no-op", addNode(SRC, "main", "auth", "page"), SRC);
  eq("an id the flow invents is taken too", addNode("@flow\n  A -> B\n", "main", "B", "page"), "@flow\n  A -> B\n");
  eq("an invalid id is a no-op", addNode(SRC, "main", "has-dash", "page"), SRC);

  const bare = "@flow\n  A -> B\n";
  const created = addNode(bare, "main", "C", "event");
  eq("@nodes created ahead of @flow", created, "@nodes\n  C = event\n\n@flow\n  A -> B\n");
  eq("and parses", errorsOf(created), 0);

  const empty = addNode("", "main", "First", "page");
  eq("an empty file gets a @nodes section", nodeList(docOf(empty)), ["First=page"]);

  eq("unique id skips taken ones", uniqueNodeId("@nodes\n  page1 = page\n", "main", "page"), "page2");
}

// 2. deleteNode ----------------------------------------------------------------
{
  const out = deleteNode(SRC, "main", "auth");
  const d = docOf(out);
  eq("node gone", d.nodes.some((n) => n.id === "auth"), false);
  eq("every edge touching it gone, others kept", edgeList(d), ["Denied-retry>Login"]);
  ok("its @node block gone", !out.includes("@node auth"));
  ok("its group header gone", !/^\s*auth:/m.test(out));
  ok("the note block under its edge gone", !out.includes("happy path"));
  ok("comments elsewhere survive", out.startsWith("# header comment\n") && out.includes("# the entry"));
  ok("no doubled blank lines", !out.includes("\n\n\n"), JSON.stringify(out));
  eq("parses clean", errorsOf(out), 0);

  const target = deleteNode(SRC, "main", "Home");
  eq("an edge into it inside someone else's group goes", edgeList(docOf(target)), [
    "Login-tap login>auth",
    "auth-401>Denied",
    "Denied-retry>Login",
  ]);
  ok("the group keeps its header while it has edges", /^\s*auth:/m.test(target));

  const lonely = "@nodes\n  A = page\n  B = page\n@flow\n  A:\n    -> B\n";
  eq("a group emptied by the delete loses its header", deleteNode(lonely, "main", "B"), "@nodes\n  A = page\n@flow\n");
  eq("an unknown id is a no-op", deleteNode(SRC, "main", "Nope"), SRC);
}

// 3. renameNode ----------------------------------------------------------------
{
  const out = renameNode(SRC, "main", "Login", "SignIn");
  const d = docOf(out);
  eq("renamed everywhere", edgeList(d), ["SignIn-tap login>auth", "auth-200>Home", "auth-401>Denied", "Denied-retry>SignIn"]);
  ok("declaration renamed, comment and alignment kept", out.includes("  SignIn   = page   # the entry"));
  ok("an edge label containing the old id is untouched", out.includes("-tap login>"));
  ok("a trailing comment on a flow line survives", out.includes("SignIn -tap login> auth   # tapping"));

  const grp = renameNode(SRC, "main", "auth", "authApi");
  ok("group header and @node block follow", /^\s*authApi:$/m.test(grp) && grp.includes("@node authApi {"));
  eq("metadata stays attached", docOf(grp).nodes.find((n) => n.id === "authApi")?.data.method, "POST");
  eq("onto a taken id is a no-op", renameNode(SRC, "main", "Login", "Home"), SRC);
  eq("to an invalid id is a no-op", renameNode(SRC, "main", "Login", "sign in"), SRC);
}

// 4. addEdge -------------------------------------------------------------------
{
  const grouped = addEdge(SRC, "main", { source: "auth", target: "Login", label: "500" });
  ok("joins the source's group, after its note block", grouped.includes("    }\n    -401> Denied\n    -500> Login\n"));
  eq("parses as a new edge", edgeList(docOf(grouped)).includes("auth-500>Login"), true);

  const inline = addEdge(SRC, "main", { source: "Home", target: "Login", label: "" });
  ok("no group: an inline line at the end of @flow", inline.endsWith("  Denied -retry> Login\n  Home -> Login\n"));
  eq("an empty label draws as ->", edgeList(docOf(inline)).includes("Home->Login"), true);

  const noFlow = addEdge("@nodes\n  A = page\n  B = page\n", "main", { source: "A", target: "B", label: "go" });
  eq("@flow created when missing", noFlow, "@nodes\n  A = page\n  B = page\n\n@flow\n  A -go> B\n");

  eq("labels can't break the arrow", safeLabel("a > b\nc"), "a b c");
  eq("a sanitised label round-trips", edgeList(docOf(addEdge(SRC, "main", { source: "Home", target: "Denied", label: "x>y" }))).includes("Home-x y>Denied"), true);
}

// 5. deleteEdge ----------------------------------------------------------------
{
  const out = deleteEdge(SRC, "main", { source: "auth", target: "Home", label: "200" });
  eq("just that edge", edgeList(docOf(out)), ["Login-tap login>auth", "auth-401>Denied", "Denied-retry>Login"]);
  ok("with its note block", !out.includes("happy path"));
  ok("the group keeps its header", /^\s*auth:/m.test(out));

  const commented = deleteEdge(SRC, "main", { source: "Login", target: "auth", label: "tap login" });
  ok("a flow line with a trailing comment is found", !commented.includes("# tapping"));

  const last = deleteEdge("@flow\n  A:\n    -x> B\n  C -> D\n", "main", { source: "A", target: "B", label: "x" });
  eq("the last edge in a group takes the header", last, "@flow\n  C -> D\n");
  eq("an edge that isn't there is a no-op", deleteEdge(SRC, "main", { source: "Home", target: "auth", label: "" }), SRC);
}

// 6. multi-doc: edits stay inside their @doc ----------------------------------
{
  const MULTI = `@doc one
@nodes
  A = page
  B = page
@flow
  A -> B

@doc two
@nodes
  A = page
  C = page
@flow
  A -> C
`;
  const out = deleteNode(MULTI, "two", "A");
  eq("doc one untouched", edgeList(docOf(out, "one")), ["A->B"]);
  eq("doc two edited", nodeList(docOf(out, "two")), ["C=page"]);
  const renamed = renameNode(MULTI, "one", "A", "Start");
  eq("rename is doc-local", [edgeList(docOf(renamed, "one")), edgeList(docOf(renamed, "two"))], [["Start->B"], ["A->C"]]);
  const added = addNode(MULTI, "one", "Z", "api");
  eq("add lands in the right doc", [nodeList(docOf(added, "one")).includes("Z=api"), nodeList(docOf(added, "two")).includes("Z=api")], [true, false]);
}

// 7. every shipped example survives every delete and rename -------------------
{
  const files = readdirSync("examples").filter((f) => f.endsWith(".fml"));
  let checked = 0;
  const problems: string[] = [];
  for (const f of files) {
    const src = readFileSync(`examples/${f}`, "utf8");
    const base = parse(src, { strict: false });
    for (const doc of base.file.docs) {
      if (doc.source) continue; // @fof imports live in another file
      for (const node of doc.nodes) {
        checked++;
        const del = deleteNode(src, doc.name, node.id);
        const after = parse(del, { strict: false });
        const d = after.file.docs.find((x) => x.name === doc.name);
        if (!d) {
          problems.push(`${f}/${doc.name}: deleting ${node.id} lost the doc`);
          continue;
        }
        if (after.errors.length > base.errors.length) problems.push(`${f}: deleting ${node.id} added parse errors`);
        if (d.nodes.some((n) => n.id === node.id)) problems.push(`${f}: ${node.id} survived its delete`);
        const expected = doc.edges.filter((e) => e.source !== node.id && e.target !== node.id);
        if (JSON.stringify(edgeList(d)) !== JSON.stringify(edgeList({ ...doc, edges: expected }))) {
          problems.push(`${f}: deleting ${node.id} changed the wrong edges`);
        }

        const fresh = uniqueNodeId(src, doc.name, "renamed");
        const ren = parse(renameNode(src, doc.name, node.id, fresh), { strict: false });
        const r = ren.file.docs.find((x) => x.name === doc.name)!;
        const swap = (id: string) => (id === node.id ? fresh : id);
        const want = doc.edges.map((e) => `${swap(e.source)}-${e.label}>${swap(e.target)}`);
        if (JSON.stringify(edgeList(r)) !== JSON.stringify(want)) problems.push(`${f}: renaming ${node.id} broke edges`);
        if (r.nodes.find((n) => n.id === fresh)?.type !== node.type) problems.push(`${f}: renaming ${node.id} lost its type`);
      }
    }
  }
  eq(`delete + rename every node in every example (${checked} nodes)`, problems, []);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
