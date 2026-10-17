// Usage: node src/fml/drift.test.ts
import { checkDrift, type DriftFinding } from "./drift.ts";
import { parse } from "./index.ts";

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

const docs = (src: string) => parse(src, { strict: false }).file.docs;
const kinds = (fs: DriftFinding[]) => fs.map((f) => `${f.nodeId}:${f.kind}`);

const OAS3 = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.test/v1" }],
  paths: {
    "/users/{id}": {
      get: { responses: { "200": {}, "404": {} } },
      delete: { responses: { "204": {} } },
    },
    "/users/me": { get: { responses: { "2XX": {} } } },
    "/login": { post: { responses: { "200": {}, "401": {} } } },
    "/health": { get: { responses: { default: {} } } },
  },
};

// 1. matching ----------------------------------------------------------------
{
  const report = checkDrift(
    docs(`@meta
  base: https://api.test/v1
@nodes
  login = api
  getUser = api
  me = api
  health = api
@node login {
  method: POST
  path: /login
  expect: 200
}
@node getUser {
  path: /users/{userId}
  expect: 200
}
@node me {
  path: /users/me?expand=all
  expect: 2xx
}
@node health {
  path: /health
  expect: 503
}
@flow
  login:
    -200> getUser
    -401> getUser
  getUser -404> me
`),
    OAS3,
  );
  eq("a flow that matches its spec has no findings", report.findings, []);
  eq("coverage counts reached operations", report.coverage.exercised, [
    "GET /users/{id}",
    "GET /users/me",
    "POST /login",
    "GET /health",
  ]);
  eq("and lists the rest", report.coverage.unexercised, ["DELETE /users/{id}"]);
}

// 2. drift -----------------------------------------------------------------
{
  const report = checkDrift(
    docs(`@meta
  base: https://api.test/v1
@nodes
  gone = api
  wrongVerb = api
  extraStatus = api
  noPath = api
@node gone {
  path: /accounts/{id}
}
@node wrongVerb {
  method: PUT
  path: /users/42
}
@node extraStatus {
  method: POST
  path: /login
  expect: 200
}
@node noPath {
  method: GET
}
@flow
  extraStatus:
    -200> gone
    -429> gone
`),
    OAS3,
  );
  eq("each kind of drift is reported", kinds(report.findings), [
    "gone:unknown-path",
    "wrongVerb:unknown-method",
    "extraStatus:undocumented-status",
    "noPath:unresolvable",
  ]);
  ok("unknown paths are errors", report.findings[0]?.severity === "error");
  ok("a wrong method names what the path does support", report.findings[1]?.message.includes("GET, DELETE") === true, report.findings[1]?.message);
  ok("an undocumented status is a warning", report.findings[2]?.severity === "warning");
  ok("and names the status", report.findings[2]?.message.includes("429") === true);
}

// 3. status coverage rules ---------------------------------------------------
{
  const one = (expect: string, responses: Record<string, unknown>) =>
    checkDrift(docs(`@nodes\n  a = api\n@node a {\n  url: https://api.test/x\n  expect: ${expect}\n}\n`), {
      paths: { "/x": { get: { responses } } },
    }).findings.length === 0;
  ok("exact code", one("200", { "200": {} }));
  ok("missing code", !one("201", { "200": {} }));
  ok("2xx in the flow, 204 in the spec", one("2xx", { "204": {} }));
  ok("204 in the flow, 2XX in the spec", one("204", { "2XX": {} }));
  ok("default documents everything", one("418", { default: {} }));
  ok("a range overlapping a documented code", one("200-204", { "201": {} }));
  ok("a list needs every member documented", !one("200,201", { "200": {} }));
}

// 4. Swagger 2.0 basePath, and a base with its own path prefix ---------------
{
  const swagger = { swagger: "2.0", host: "legacy.test", basePath: "/api", paths: { "/items/{id}": { get: { responses: { "200": {} } } } } };
  const viaBase = checkDrift(docs(`@meta\n  base: https://legacy.test/api\n@nodes\n  a = api\n@node a {\n  path: /items/7\n}\n`), swagger);
  eq("basePath is stripped before matching", viaBase.findings, []);
  const viaUrl = checkDrift(docs(`@nodes\n  a = api\n@node a {\n  url: https://legacy.test/api/items/{id}\n}\n`), swagger);
  eq("so is an absolute url's path", viaUrl.findings, []);
}

// 5. multi-host flows only check the host the spec describes -----------------
{
  const report = checkDrift(
    docs(`@meta\n  base: https://api.test/v1\n@nodes\n  a = api\n  b = api\n@node a {\n  path: /health\n}\n@node b {\n  base: https://auth.other.test\n  path: /anything\n}\n`),
    OAS3,
  );
  eq("the other host's node is skipped, not reported", report.findings, []);
  eq("and listed as skipped", report.skipped, [{ doc: "main", nodeId: "b", origin: "auth.other.test" }]);

  const templated = checkDrift(
    docs(`@nodes\n  a = api\n@node a {\n  base: https://{tenant}.api.test\n  path: /nope\n}\n`),
    OAS3,
  );
  eq("a host with a {var} can't be ruled out, so it's checked", kinds(templated.findings), ["a:unknown-path"]);
}

// 6. a literal spec path beats a template for the same request ---------------
{
  const spec = {
    paths: {
      "/users/{id}": { get: { responses: { "200": {} } } },
      "/users/me": { get: { responses: { "204": {} } } },
    },
  };
  const r = checkDrift(docs(`@nodes\n  a = api\n@node a {\n  url: https://x.test/users/me\n  expect: 204\n}\n`), spec);
  eq("/users/me matches /users/me, not /users/{id}", r.coverage.exercised, ["GET /users/me"]);
}

// 7. every doc in a multi-doc file is checked ---------------------------------
{
  const r = checkDrift(
    docs(`@doc one\n@nodes\n  a = api\n@node a {\n  url: https://api.test/v1/nope\n}\n@doc two\n@nodes\n  b = api\n@node b {\n  url: https://api.test/v1/also-nope\n}\n`),
    OAS3,
  );
  eq("findings carry their doc", r.findings.map((f) => `${f.doc}/${f.nodeId}`), ["one/a", "two/b"]);
}

// 7b. a base written as a variable is an origin, not a path segment
{
  const r = checkDrift(docs(`@meta\n  base: {apiBase}/v1\n@nodes\n  a = api\n@node a {\n  path: /health\n}\n`), OAS3);
  eq("{apiBase}/v1 matches the spec's /v1 server", r.findings, []);
  const bare = checkDrift(docs(`@meta\n  base: {apiBase}\n@nodes\n  a = api\n@node a {\n  path: /login\n  method: POST\n}\n`), {
    paths: { "/login": { post: { responses: { "200": {} } } } },
  });
  eq("a bare {apiBase} contributes no segment", bare.findings, []);
}

// 8. garbage in, empty report out — never a throw ----------------------------
{
  const r = checkDrift(docs(`@nodes\n  a = api\n@node a {\n  url: https://x.test/a\n}\n`), "not a spec");
  eq("no spec paths means every request is unknown", kinds(r.findings), ["a:unknown-path"]);
  eq("and coverage is empty", r.coverage.total, 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
