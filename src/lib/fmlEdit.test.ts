// Usage: node src/lib/fmlEdit.test.ts
import { parse } from "../fml/index.ts";
import {
  nodeSource,
  renameVar,
  setEdgeLabel,
  setEdgeNote,
  setNodeBlock,
  setNodeSource,
  setNodeType,
  setVar,
} from "./fmlEdit.ts";

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

const SINGLE = `# a comment
@meta
  title: T

@nodes
  Login = page
  authApi = api

@node authApi {
  method: POST
  path: /api/v1/login
}

@flow
  Login -tap> authApi
  authApi:
    -200> Login
    -401> Login
`;

// 1. change an existing @node value, keep the comment + everything else
{
  const out = setNodeBlock(SINGLE, "main", "authApi", {
    method: "PUT",
    path: "/api/v1/login",
  });
  ok("comment survives", out.startsWith("# a comment"));
  const r = parse(out);
  const n = r.doc.nodes.find((x) => x.id === "authApi")!;
  ok("method changed", n.data.method === "PUT", JSON.stringify(n.data));
  ok("path kept", n.data.path === "/api/v1/login");
}

// 2. add a key
{
  const out = setNodeBlock(SINGLE, "main", "authApi", {
    method: "POST",
    path: "/api/v1/login",
    auth: "none",
  });
  const n = parse(out).doc.nodes.find((x) => x.id === "authApi")!;
  ok("key added", n.data.auth === "none");
}

// 3. remove a key (omit it from data)
{
  const out = setNodeBlock(SINGLE, "main", "authApi", { method: "POST" });
  const n = parse(out).doc.nodes.find((x) => x.id === "authApi")!;
  ok("key removed", n.data.path === undefined && n.data.method === "POST", JSON.stringify(n.data));
}

// 4. empty data removes the whole block
{
  const out = setNodeBlock(SINGLE, "main", "authApi", {});
  ok("no @node line left", !/@node\s+authApi/.test(out));
  ok("still parses", parse(out).ok);
}

// 5. create a block for a node that had none
{
  const out = setNodeBlock(SINGLE, "main", "Login", { image: "screens/login.png" });
  const n = parse(out).doc.nodes.find((x) => x.id === "Login")!;
  ok("block created", n.data.image === "screens/login.png", JSON.stringify(n.data));
  ok("still one Login node", parse(out).doc.nodes.filter((x) => x.id === "Login").length === 1);
}

// 6. edits are scoped to the right @doc
{
  const multi = `@doc a
@nodes
  X = page
@node X {
  role: first
}

@doc b
@nodes
  X = api
@node X {
  role: second
}
`;
  const out = setNodeBlock(multi, "b", "X", { role: "changed" });
  const r = parse(out);
  ok("doc a untouched", r.file.docs[0]!.nodes[0]!.data.role === "first");
  ok("doc b changed", r.file.docs[1]!.nodes[0]!.data.role === "changed");
}

// 7. setNodeType rewrites the declaration
{
  const out = setNodeType(SINGLE, "main", "authApi", "page");
  const n = parse(out).doc.nodes.find((x) => x.id === "authApi")!;
  ok("type changed", n.type === "page");
  ok("block intact after type change", n.data.method === "POST");
}

// 8. setEdgeLabel — inline edge
{
  const out = setEdgeLabel(SINGLE, "main", { source: "Login", target: "authApi", label: "tap" }, "press");
  const e = parse(out).doc.edges.find((x) => x.source === "Login" && x.target === "authApi")!;
  ok("inline label changed", e.label === "press", e.label);
}

// 9. setEdgeLabel — grouped edge (only the matching branch)
{
  const out = setEdgeLabel(SINGLE, "main", { source: "authApi", target: "Login", label: "401" }, "403");
  const r = parse(out);
  const labels = r.doc.edges
    .filter((x) => x.source === "authApi" && x.target === "Login")
    .map((x) => x.label)
    .sort();
  ok("one branch relabelled", JSON.stringify(labels) === JSON.stringify(["200", "403"]), JSON.stringify(labels));
}

// 10. setEdgeLabel — clearing to empty
{
  const out = setEdgeLabel(SINGLE, "main", { source: "Login", target: "authApi", label: "tap" }, "");
  const e = parse(out).doc.edges.find((x) => x.source === "Login" && x.target === "authApi")!;
  ok("label cleared", e.label === "", `"${e.label}"`);
}

// 11. setEdgeNote — add a block to an edge that has none
{
  const out = setEdgeNote(
    SINGLE,
    "main",
    { source: "Login", target: "authApi", label: "tap" },
    { why: "user taps sign in", owner: "auth-team" },
  );
  const r = parse(out);
  const e = r.doc.edges.find((x) => x.source === "Login" && x.target === "authApi")!;
  ok("note added", e.data?.why === "user taps sign in", JSON.stringify(e.data));
  ok("second key added", e.data?.owner === "auth-team");
  ok("label survives note", e.label === "tap", e.label);
  ok("still parses clean", r.ok, JSON.stringify(r.errors));
  ok("rest of file untouched", out.includes("@node authApi {") && out.startsWith("# a comment"));
}

// 12. setEdgeNote — replace the body of an existing block, on a grouped edge
{
  const withNote = setEdgeNote(
    SINGLE,
    "main",
    { source: "authApi", target: "Login", label: "401" },
    { why: "bad password" },
  );
  const out = setEdgeNote(
    withNote,
    "main",
    { source: "authApi", target: "Login", label: "401" },
    { why: "bad password", retry: "3" },
  );
  const r = parse(out);
  const e = r.doc.edges.find((x) => x.label === "401")!;
  ok("grouped note replaced", e.data?.retry === "3", JSON.stringify(e.data));
  ok("sibling branch untouched", r.doc.edges.find((x) => x.label === "200")!.data === undefined);
  ok("grouped note parses", r.ok, JSON.stringify(r.errors));
}

// 13. setEdgeNote — empty data removes the block and its brace
{
  const withNote = setEdgeNote(
    SINGLE,
    "main",
    { source: "Login", target: "authApi", label: "tap" },
    { why: "x" },
  );
  const out = setEdgeNote(withNote, "main", { source: "Login", target: "authApi", label: "tap" }, {});
  const r = parse(out);
  const e = r.doc.edges.find((x) => x.source === "Login" && x.target === "authApi")!;
  ok("note removed", e.data === undefined, JSON.stringify(e.data));
  ok("no stray brace", !/\{\s*$/m.test(out.split("@flow")[1]!), out.split("@flow")[1]);
  ok("edge intact after removal", e.label === "tap" && r.ok);
}

// 14. a note body never gets mistaken for a group header
{
  const withNote = setEdgeNote(
    SINGLE,
    "main",
    { source: "Login", target: "authApi", label: "tap" },
    { blocked: "" , note: "see runbook" },
  );
  // `blocked:` has an empty value and is dropped; `note:` stays inside the block.
  const out = setEdgeLabel(withNote, "main", { source: "authApi", target: "Login", label: "200" }, "201");
  const r = parse(out);
  const e = r.doc.edges.find((x) => x.source === "authApi" && x.target === "Login" && x.label === "201");
  ok("group still resolved past a note block", e !== undefined, JSON.stringify(r.doc.edges));
  ok("note survived the label edit", r.doc.edges.find((x) => x.label === "tap")!.data?.note === "see runbook");
}

// 15. nodeSource — decl line + verbatim block
{
  const s = nodeSource(SINGLE, "main", "authApi");
  ok("decl line first", s.startsWith("authApi = api"), s);
  ok("block included", s.includes("@node authApi {") && s.includes("method: POST"), s);
  ok("closes the block", s.trimEnd().endsWith("}"), s);
  const bare = nodeSource(SINGLE, "main", "Login");
  ok("node with no block is just the decl", bare === "Login = page", bare);
}

// 16. setNodeSource — round-trips an edited block + type
{
  const edited = `authApi = api
@node authApi {
  method: PUT
  path: /api/v2/login
  auth: bearer
}`;
  const out = setNodeSource(SINGLE, "main", "authApi", edited);
  const r = parse(out);
  const n = r.doc.nodes.find((x) => x.id === "authApi")!;
  ok("type kept", n.type === "api", n.type);
  ok("value changed via code tab", n.data.method === "PUT" && n.data.path === "/api/v2/login");
  ok("key added via code tab", n.data.auth === "bearer");
  ok("comment + rest of file survive", out.includes("# a comment") && r.ok, JSON.stringify(r.errors));
}

// 17. setNodeSource — a retyped decl changes the node type
{
  const out = setNodeSource(SINGLE, "main", "Login", "Login = decision");
  const r = parse(out);
  ok("code-tab type swap", r.doc.nodes.find((x) => x.id === "Login")!.type === "decision");
}

// A trailing comment on a flow line used to make the edge invisible to these
// edits — the regexes required the line to end right after the target.
{
  const src = "@nodes\n  A = page\n  B = page\n@flow\n  A -go> B   # why we go\n";
  const relabelled = setEdgeLabel(src, "main", { source: "A", target: "B", label: "go" }, "leave");
  ok("relabels a commented flow line", relabelled.includes("A -leave> B   # why we go"), relabelled);
  const noted = setEdgeNote(src, "main", { source: "A", target: "B", label: "go" }, { note: "x" });
  ok("adds a note to a commented flow line", noted.includes("A -go> B {   # why we go\n    note: x\n  }"), noted);
  ok("which still parses as one edge with its note", parse(noted).doc.edges[0]?.data?.note === "x");
}

// 18. @vars (FML-27)
{
  const src = "@meta\n  title: t\n\n@vars\n  email: a@b.c   # who\n\n@nodes\n  a = api\n@node a {\n  body: {email} {pw}  # {email} stays\n}\n";
  const changed = setVar(src, "main", "email", "x@y.z");
  ok("changes a value in place", parse(changed).doc.vars.email === "x@y.z" && changed.includes("@meta\n  title: t"), changed);
  const added = setVar(src, "main", "pw", "secret");
  ok("adds an entry at the end of @vars", added.includes("  email: a@b.c   # who\n  pw: secret"), added);
  const removed = setVar(src, "main", "email", null);
  ok("removes an entry", !removed.includes("email: a@b.c") && parse(removed).ok, removed);
  const fresh = setVar("@nodes\n  a = page\n", "main", "x", "1");
  ok("opens @vars ahead of @nodes when there's none", fresh.startsWith("@vars\n  x: 1\n\n@nodes") && parse(fresh).doc.vars.x === "1", fresh);
  ok("an empty value is allowed (filled in later)", parse(setVar(src, "main", "pw", "")).doc.vars.pw === "");
  const renamed = renameVar(src, "main", "email", "user");
  ok("rename moves the entry and every {ref}", renamed.includes("  user: a@b.c") && renamed.includes("body: {user} {pw}"), renamed);
  ok("but not inside a comment", renamed.includes("# {email} stays"));
  ok("rename onto a taken name is refused", renameVar(added, "main", "email", "pw") === added);
  ok("a run-time input (no entry) can be renamed too", renameVar(src, "main", "pw", "password").includes("{password}"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
