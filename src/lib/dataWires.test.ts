// Usage: node src/lib/dataWires.test.ts
import { parse } from "../fml/index.ts";
import { dataGraph, visibleDataGraph, wireOptions } from "./dataWires.ts";

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

const SRC = `
@vars
  email: jb@arque.app

@nodes
  Start  = page
  login  = api
  getMe  = api
  income = api

@node login {
  method: POST
  path: /login
  body: {"email":"{email}","password":"{password}"}
  capture.token: $.token
  capture.userId: $.id
}

@node getMe {
  path: /users/{userId}
  auth: bearer {token}
  header.X-Trace: {token}
}

@node income {
  path: /income
  capture.rate: $.rate
  assert.echo: $.echo == {rate}
}

@flow
  Start -> login
  login -200> getMe
  getMe -200> income
`;
const doc = parse(SRC, { strict: false }).doc;
const g = dataGraph(doc);

// 1. ports -----------------------------------------------------------------
{
  eq("outputs are the node's captures", g.ports.get("login")?.outputs, ["token", "userId"]);
  eq("inputs are its {name}s, with where each comes from", g.ports.get("login")?.inputs, [
    { name: "email", source: "vars" },
    { name: "password", source: "input" },
  ]);
  eq("a name used in two fields is one input port", g.ports.get("getMe")?.inputs.map((p) => p.name), ["userId", "token"]);
  ok("a node with no variables has no ports", !g.ports.has("Start"));
}

// 2. wires -----------------------------------------------------------------
{
  eq("one wire per captured name per consumer", g.wires.map((w) => `${w.source}>${w.target}:${w.name}`), [
    "login>getMe:userId",
    "login>getMe:token",
  ]);
  ok("a node spending its own capture draws no wire", !g.wires.some((w) => w.source === w.target));
  ok("@vars and run-time inputs have ports but no wires", !g.wires.some((w) => w.name === "email" || w.name === "password"));
}

// 3. what's visible ---------------------------------------------------------
{
  eq("Data on: everything", visibleDataGraph(g, true, null), g);
  eq("off, nothing selected: nothing", visibleDataGraph(g, false, null).wires, []);
  const sel = visibleDataGraph(g, false, "getMe");
  eq("off, a node selected: its wires", sel.wires.length, 2);
  eq("its own ports in full", sel.ports.get("getMe"), g.ports.get("getMe"));
  eq("and only the far ends' ports those wires use", sel.ports.get("login"), { inputs: [], outputs: ["userId", "token"] });
  eq("unrelated nodes show nothing", sel.ports.has("income"), false);
}

// 4. where a dropped wire can go ----------------------------------------------
{
  const opts = wireOptions({ method: "GET", path: "/me", body: "", "capture.x": "$.x", label: "Me" }, "api", "token");
  eq("free-text fields get it appended; method/label/capture are skipped; api extras offered", opts, [
    { label: "path: …/{token}", key: "path", value: "/me/{token}" },
    { label: "body: …{token}", key: "body", value: "{token}" },
    { label: "auth: bearer {token}", key: "auth", value: "bearer {token}" },
    { label: "query.token: {token}", key: "query.token", value: "{token}" },
  ]);
  eq("a field that already has it isn't offered", wireOptions({ auth: "bearer {token}" }, "api", "token").map((o) => o.key), ["query.token"]);
  eq("non-api nodes only get their own fields", wireOptions({ note: "hi" }, "page", "token").map((o) => o.key), ["note"]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
