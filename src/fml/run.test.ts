// Usage: node src/fml/run.test.ts
//
// The engine never touches the network — every test here drives it with a fake
// transport, which is the whole point of injecting one.

import { parse } from "./index.ts";
import {
  buildRequest,
  chooseEdge,
  interpolate,
  readPath,
  requiredInputs,
  runFlow,
  runNode,
  statusMatches,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./run.ts";

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

/** A transport that answers from a canned table and records what it was sent. */
function fakeTransport(
  answers: Array<Partial<HttpResponse>>,
): { transport: Transport; sent: HttpRequest[] } {
  const sent: HttpRequest[] = [];
  let i = 0;
  const transport: Transport = async (req) => {
    sent.push(req);
    const canned = answers[Math.min(i, answers.length - 1)] ?? {};
    i++;
    return { status: canned.status ?? 200, headers: canned.headers ?? {}, body: canned.body ?? "" };
  };
  return { transport, sent };
}

// 1. interpolation ---------------------------------------------------------
{
  eq("substitutes", interpolate("Bearer {token}", { token: "abc" }).text, "Bearer abc");
  eq("reports a gap", interpolate("{a}/{b}", { a: "1" }).missing, ["b"]);
  eq("leaves a gap verbatim", interpolate("{a}/{b}", { a: "1" }).text, "1/{b}");
  eq("gap listed once", interpolate("{b}{b}", {}).missing, ["b"]);
}

// 2. readPath --------------------------------------------------------------
{
  const res: HttpResponse = {
    status: 201,
    headers: { "X-Request-Id": "r-42", "Content-Type": "application/json" },
    body: JSON.stringify({ data: { token: "t0k", n: 7, ok: true }, items: [{ id: "a" }, { id: "b" }] }),
  };
  eq("dollar path", readPath(res, "$.data.token"), "t0k");
  eq("path without $", readPath(res, "data.token"), "t0k");
  eq("array index", readPath(res, "$.items[1].id"), "b");
  eq("number stringified", readPath(res, "$.data.n"), "7");
  eq("boolean stringified", readPath(res, "$.data.ok"), "true");
  eq("object stringified", readPath(res, "$.items[0]"), '{"id":"a"}');
  eq("status", readPath(res, "status"), "201");
  eq("header case-insensitive", readPath(res, "header.x-request-id"), "r-42");
  eq("whole body", readPath(res, "$"), res.body);
  eq("missing path is undefined", readPath(res, "$.data.nope"), undefined);
  eq("non-json body is undefined", readPath({ ...res, body: "hi" }, "$.a"), undefined);
}

// 3. statusMatches ---------------------------------------------------------
{
  ok("exact", statusMatches("200", 200));
  ok("list", statusMatches("200,201", 201));
  ok("wildcard", statusMatches("2xx", 204));
  ok("range", statusMatches("200-204", 202));
  ok("no match", !statusMatches("200,201", 404));
  ok("wildcard class boundary", !statusMatches("2xx", 302));
}

// 4. buildRequest ----------------------------------------------------------
{
  const node = {
    id: "getCart",
    type: "api",
    data: {
      method: "get",
      path: "/cart/{cartId}",
      "header.Accept": "application/json",
      "query.page": "2",
      auth: "bearer {token}",
    },
  };
  const built = buildRequest(node, { base: "https://api.example.com/" }, { token: "t0k", cartId: "c1" });
  eq("method upper-cased", built.request?.method, "GET");
  eq("base joined without a double slash", built.request?.url, "https://api.example.com/cart/c1?page=2");
  eq("bearer sugar", built.request?.headers.Authorization, "Bearer t0k");
  eq("explicit header kept", built.request?.headers.Accept, "application/json");
  eq("nothing missing", built.missing, []);

  const gap = buildRequest(node, { base: "https://api.example.com" }, { cartId: "c1" });
  eq("missing var reported", gap.missing, ["token"]);

  const absolute = buildRequest(
    { id: "x", type: "api", data: { url: "https://other.test/ping" } },
    {},
    {},
  );
  eq("url wins over base", absolute.request?.url, "https://other.test/ping");

  const noTarget = buildRequest({ id: "x", type: "api", data: { method: "GET" } }, {}, {});
  ok("needs a url or path", !!noTarget.error);

  const relativeNoBase = buildRequest({ id: "x", type: "api", data: { path: "/a" } }, {}, {});
  ok("relative path without a base is an error", !!relativeNoBase.error);

  // Multi-host: a node's own `base` overrides `@meta base` — auth on one
  // service, billing on another, in the same file.
  const nodeBaseWins = buildRequest(
    { id: "sendOtp", type: "api", data: { base: "https://auth.example.com", path: "/otp" } },
    { base: "https://api.example.com" },
    {},
  );
  eq("node base overrides @meta base", nodeBaseWins.request?.url, "https://auth.example.com/otp");

  const nodeBaseFallsBack = buildRequest(
    { id: "checkout", type: "api", data: { path: "/billing/checkout" } },
    { base: "https://api.example.com" },
    {},
  );
  eq(
    "no node base falls back to @meta base",
    nodeBaseFallsBack.request?.url,
    "https://api.example.com/billing/checkout",
  );

  const nodeBaseInterpolated = buildRequest(
    { id: "x", type: "api", data: { base: "https://{tenant}.example.com", path: "/x" } },
    {},
    { tenant: "acme" },
  );
  eq("a node base can interpolate {name} too", nodeBaseInterpolated.request?.url, "https://acme.example.com/x");

  const json = buildRequest(
    { id: "x", type: "api", data: { method: "POST", url: "https://a.test", body: '{"a":1}' } },
    {},
    {},
  );
  eq("json content-type inferred", json.request?.headers["Content-Type"], "application/json");
}

// 5. runNode — capture threads into the store ------------------------------
{
  const node = {
    id: "login",
    type: "api",
    data: {
      method: "POST",
      url: "https://api.test/auth/login",
      body: '{"email":"{email}"}',
      "capture.token": "$.data.token",
      expect: "200,201",
    },
  };
  const vars: Record<string, string> = { email: "jb@arque.app" };
  const { transport, sent } = fakeTransport([
    { status: 201, body: JSON.stringify({ data: { token: "t0k" } }) },
  ]);
  const step = await runNode(node, {}, vars, transport);
  ok("step passed", step.ok, step.error);
  eq("body interpolated", sent[0]?.body, '{"email":"jb@arque.app"}');
  eq("captured into the store", vars.token, "t0k");
  eq("capture reported", step.captures[0]?.ok, true);

  const bad = await runNode({ ...node, data: { ...node.data, expect: "200" } }, {}, {}, transport);
  ok("status assertion fails loudly", !bad.ok);

  const noCapture = await runNode(
    { id: "l", type: "api", data: { url: "https://a.test", "capture.x": "$.nope" } },
    {},
    {},
    (await fakeTransport([{ status: 200, body: "{}" }])).transport,
  );
  ok("a capture that finds nothing fails the step", !noCapture.ok);

  const page = await runNode({ id: "Home", type: "page", data: {} }, {}, {}, transport);
  ok("a page node sends nothing", page.passthrough && page.ok);
}

// 6. chooseEdge ------------------------------------------------------------
{
  const edges = [
    { id: "e1", source: "a", target: "ok", label: "200,201" },
    { id: "e2", source: "a", target: "bad", label: "404" },
  ];
  eq("status picks the branch", chooseEdge(edges, 201)?.target, "ok");
  eq("other status picks the other", chooseEdge(edges, 404)?.target, "bad");
  eq("no match, no guess", chooseEdge(edges, 500), undefined);
  eq("lone edge taken whatever its label", chooseEdge([edges[0]!], undefined)?.target, "ok");
}

// 7. the whole point — one run, token threaded between two APIs ------------
{
  const SRC = `
@meta
  base: https://api.test

@vars
  email: jb@arque.app

@nodes
  Start    = page
  login    = api
  getMe    = api
  Home     = page
  Denied   = page

@node login {
  method: POST
  path: /auth/login
  body: {"email":"{email}","password":"{password}"}
  capture.token: $.data.token
  expect: 200
}

@node getMe {
  method: GET
  path: /me
  auth: bearer {token}
  capture.userId: $.id
  expect: 200
}

@flow
  Start -go> login
  login:
    -200> getMe
    -401> Denied
  getMe -200> Home
`;
  const doc = parse(SRC, { strict: false }).doc;

  eq("password is the only run-time input", requiredInputs(doc), ["password"]);

  // A {name} on a page node is documentation, not an input — a run never
  // sends it, so demanding a value for it would block the run for nothing.
  const withPageVar = parse(
    `@nodes\n  Home = page\n  a = api\n@node Home {\n  note: hi {nobodyNeedsThis}\n}\n@node a {\n  url: https://x.test\n}\n`,
    { strict: false },
  ).doc;
  eq("a page's {name} is not a required input", requiredInputs(withPageVar), []);

  const { transport, sent } = fakeTransport([
    { status: 200, body: JSON.stringify({ data: { token: "t0k" } }) },
    { status: 200, body: JSON.stringify({ id: "u_1" }) },
  ]);
  const run = await runFlow(doc, { transport, vars: { password: "hunter2" } });

  ok("run passed", run.ok, `${run.stoppedBecause} ${run.steps.find((s) => !s.ok)?.error ?? ""}`);
  eq("walked the whole path", run.steps.map((s) => s.nodeId), ["Start", "login", "getMe", "Home"]);
  eq("secret came from the caller, not the file", JSON.parse(sent[0]!.body!).password, "hunter2");
  eq("token captured", run.vars.token, "t0k");
  eq("SECOND REQUEST CARRIES THE CAPTURED TOKEN", sent[1]?.headers.Authorization, "Bearer t0k");
  eq("second capture too", run.vars.userId, "u_1");

  // A 401 is a *modelled* outcome — the file draws `-401> Denied`. By default
  // the walk follows it, so you see where the sad path goes, and the run is
  // still red because `expect: 200` failed.
  const failing = fakeTransport([{ status: 401, body: "{}" }]);
  const denied = await runFlow(doc, { transport: failing.transport, vars: { password: "wrong" } });
  eq("401 walks its drawn edge by default", denied.steps.map((s) => s.nodeId), ["Start", "login", "Denied"]);
  ok("and the run is still red", !denied.ok);
  eq("reached the end of the sad path", denied.stoppedBecause, "end");

  const fast = fakeTransport([{ status: 401, body: "{}" }]);
  const bail = await runFlow(doc, {
    transport: fast.transport,
    vars: { password: "wrong" },
    stopOnFailure: true,
  });
  eq("--fail-fast stops at the failure", bail.steps.map((s) => s.nodeId), ["Start", "login"]);
  eq("and says why", bail.stoppedBecause, "failed");
}

// 8. guards ----------------------------------------------------------------
{
  const doc = parse(`@nodes\n  A = page\n  B = page\n@flow\n  A -x> B\n  B -y> A\n`, { strict: false }).doc;
  const { transport } = fakeTransport([{}]);
  const run = await runFlow(doc, { transport, maxSteps: 6 });
  eq("cycle guard stops the walk", run.stoppedBecause, "maxSteps");
  eq("stopped at the cap", run.steps.length, 6);

  const branchy = parse(`@nodes\n  A = page\n  B = page\n  C = page\n@flow\n  A -one> B\n  A -two> C\n`, {
    strict: false,
  }).doc;
  const amb = await runFlow(branchy, { transport });
  eq("an unevaluable branch stops honestly", amb.stoppedBecause, "ambiguous");
  eq("and says where", amb.ambiguousAt, "A");
}

// 9. a missing variable stops the request going out at all -----------------
{
  const doc = parse(
    `@meta\n  base: https://api.test\n@nodes\n  a = api\n@node a {\n  path: /x\n  auth: bearer {token}\n}\n`,
    { strict: false },
  ).doc;
  const { transport, sent } = fakeTransport([{}]);
  const run = await runFlow(doc, { transport });
  ok("step failed", !run.ok);
  eq("nothing was sent", sent.length, 0);
  ok("error names the variable", run.steps[0]?.error?.includes("{token}") === true, run.steps[0]?.error);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
