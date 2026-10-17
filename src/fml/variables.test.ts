// Usage: node src/fml/variables.test.ts
import { parse } from "./index.ts";
import { nodeVarUsage, resolveVariables, varsInNode, varsInValue } from "./variables.ts";

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

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `got ${a}, want ${e}`);
}

// 1. varsInValue finds every {name}, de-duplicated, in order
{
  eq("plain", varsInValue("Bearer {token}"), ["token"]);
  eq("two names", varsInValue('{"email":"{email}","password":"{password}"}'), ["email", "password"]);
  eq("de-duped", varsInValue("{token} and {token} again"), ["token"]);
  eq("none", varsInValue("no variables here"), []);
  eq("ignores a bare brace", varsInValue("{ not an identifier }"), []);
}

// 2. varsInNode scans every value on the node
{
  const node = {
    id: "authLogin",
    type: "api",
    data: {
      method: "POST",
      body: '{"email":"{email}","password":"{password}"}',
      "header.Authorization": "Bearer {token}",
    },
  };
  eq("all three", varsInNode(node).sort(), ["email", "password", "token"]);
}

const SRC = `
@vars
  email: test@example.com

@nodes
  authLogin = api
  getCart   = api

@node authLogin {
  method: POST
  path: /auth/login
  body: {"email": "{email}", "password": "{password}"}
  capture.token: $.data.token
}

@node getCart {
  method: GET
  path: /cart
  header.Authorization: Bearer {token}
}

@flow
  authLogin -200> getCart
`;

// 3. resolveVariables: @vars defaults + every capture.<name> in the doc
{
  const { doc } = parse(SRC, { strict: false });
  const resolved = resolveVariables(doc);
  eq("email from vars", resolved.get("email"), { name: "email", source: "vars", value: "test@example.com" });
  eq("token from capture", resolved.get("token"), { name: "token", source: "capture", capturedBy: "authLogin" });
  ok("password not resolved", resolved.get("password") === undefined);
}

// 4. nodeVarUsage: per-node view, including the unresolved case
{
  const { doc } = parse(SRC, { strict: false });
  const resolved = resolveVariables(doc);
  const authLogin = doc.nodes.find((n) => n.id === "authLogin")!;
  const usage = nodeVarUsage(authLogin, resolved);

  const email = usage.find((u) => u.name === "email")!;
  ok("email resolved", email.resolved?.source === "vars");

  const password = usage.find((u) => u.name === "password")!;
  ok("password is a run-time input", password.resolved === undefined);

  const getCart = doc.nodes.find((n) => n.id === "getCart")!;
  const cartUsage = nodeVarUsage(getCart, resolved);
  eq("getCart references token", cartUsage.map((u) => u.name), ["token"]);
  ok("token resolved via capture", cartUsage[0]!.resolved?.source === "capture");
}

// 5. @vars wins if a name is somehow both declared and captured
{
  const src = `
@vars
  token: fallback-value

@nodes
  authLogin = api
@node authLogin {
  method: POST
  path: /login
  capture.token: $.data.token
}
`;
  const { doc } = parse(src, { strict: false });
  const resolved = resolveVariables(doc);
  eq("vars takes priority", resolved.get("token"), { name: "token", source: "vars", value: "fallback-value" });
}

// ask.<name> (FML-26) supplies a variable — a person types it mid-run
{
  const { doc } = parse(`@nodes\n  A = page\n  B = page\n@node A {\n  ask.otp: Code?\n}\n@node B {\n  note: {otp}\n}\n`, { strict: false });
  eq("an asked name resolves to its asker", resolveVariables(doc).get("otp"), { name: "otp", source: "ask", capturedBy: "A" });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
