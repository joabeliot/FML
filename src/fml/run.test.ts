// Usage: node src/fml/run.test.ts
//
// The engine never touches the network — every test here drives it with a fake
// transport, which is the whole point of injecting one.

import { evaluateAssertion, parseAssertion, type Assertion } from "./assert.ts";
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
  eq(".length on an array", readPath(res, "$.items.length"), "2");
  eq(".length without $", readPath(res, "items.length"), "2");
  eq(
    "length is still a key on an object",
    readPath({ ...res, body: JSON.stringify({ o: { length: "long" } }) }, "$.o.length"),
    "long",
  );
  eq(".length only as the last segment", readPath(res, "$.items.length.x"), undefined);
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

// 5b. assertion grammar ---------------------------------------------------
{
  const parsed = (label: string, value: string): Assertion | string => {
    const p = parseAssertion(label, value);
    return p.ok ? p.assertion : p.error;
  };
  const op = (label: string, value: string): string => {
    const p = parsed(label, value);
    return typeof p === "string" ? `error: ${p}` : `${p.path} ${p.op} ${p.operand}`;
  };
  eq("bare value is exact", op("data.status", "active"), "data.status eq active");
  eq("suffix is the path", op("sources.length", ">= 2"), "sources.length ge 2");
  eq("== spelled out", op("n", "== 7"), "n eq 7");
  eq("!=", op("n", "!= 7"), "n ne 7");
  eq("<=", op("n", "<= 7"), "n le 7");
  eq(">", op("n", "> 7"), "n gt 7");
  eq("<", op("n", "< 7"), "n lt 7");
  eq("~ with absolute tolerance", op("rate", "~11900+-50"), "rate approx 11900+-50");
  eq("~ with relative tolerance", op("rate", "~11900+-1%"), "rate approx 11900+-1%");
  eq("$ value names its own path", op("first", "$.items[0].id == a"), "$.items[0].id eq a");
  eq("$ path with a bare value", op("first", "$.items[0].id a"), "$.items[0].id eq a");
  eq("exists", op("header.ETag", "exists"), "header.ETag exists ");
  eq("absent", op("data.error", "absent"), "data.error absent ");
  eq("matches", op("header.ETag", 'matches ^W/"'), 'header.ETag matches ^W/"');
  ok("bare ~N is rejected", op("rate", "~11900").includes("needs a tolerance"));
  ok("garbage after ~ is rejected", op("rate", "~abc").includes("isn't a tolerance"));
  ok(">= needs a number", op("n", ">= lots").includes("needs a number"));
  ok("empty comparison", op("n", "").includes("nothing to compare"));
  ok("$ path with nothing after", op("x", "$.a").includes("nothing to compare"));
  ok("bad regex", op("x", "matches (").includes("bad pattern"));
  ok("{name} operand is not number-checked", typeof parsed("n", ">= {min}") !== "string");

  const check = (value: string, actual: string | undefined, operand?: string): boolean => {
    const p = parseAssertion("x", value);
    if (!p.ok) return false;
    return evaluateAssertion(p.assertion, actual, operand ?? p.assertion.operand).ok;
  };
  ok("exact string", check("active", "active"));
  ok("exact string mismatch", !check("active", "inactive"));
  ok("numbers compare as numbers", check("7", "7.0"));
  ok("quotes force a string compare", !check('"7"', "7.0"));
  ok("quotes allow a leading operator", check('">= 2"', ">= 2"));
  ok(">= pass", check(">= 2", "3"));
  ok(">= boundary", check(">= 2", "2"));
  ok(">= fail", !check(">= 2", "1"));
  ok("< on a non-number fails", !check("< 2", "abc"));
  ok("~ absolute pass", check("~11900+-50", "11949"));
  ok("~ absolute fail", !check("~11900+-50", "11951"));
  ok("~ relative pass", check("~11900+-1%", "12018"));
  ok("~ relative fail", !check("~11900+-1%", "12020"));
  ok("!= pass", check("!= 0", "1"));
  ok("!= fail", !check("!= 0", "0.0"));
  ok("matches pass", check('matches ^W/"', 'W/"abc"'));
  ok("matches fail", !check('matches ^W/"', '"abc"'));
  ok("exists pass", check("exists", ""));
  ok("exists fail", !check("exists", undefined));
  ok("absent pass", check("absent", undefined));
  ok("absent fail", !check("absent", "x"));
  ok("nothing at the path fails a comparison", !check("== 1", undefined));
}

// 5c. runNode — asserts score the body -------------------------------------
{
  const income = {
    id: "income",
    type: "api",
    data: {
      url: "https://api.test/income",
      "capture.rate": "$.data.income_rate",
      expect: "200",
      "assert.data.income_rate": "~11900+-50",
      "assert.sources.length": ">= 2",
      "assert.echo": "$.data.echo == {rate}",
    },
  };
  const good = fakeTransport([
    { status: 200, body: JSON.stringify({ data: { income_rate: 11920, echo: 11920 }, sources: [1, 2] }) },
  ]);
  const pass = await runNode(income, {}, {}, good.transport);
  ok("all asserts pass", pass.ok, pass.error);
  eq("every assert reported", pass.asserts.map((a) => a.ok), [true, true, true]);
  eq("actual recorded", pass.asserts[1]?.actual, "2");
  eq("an assert can compare against a value captured on the same node", pass.asserts[2]?.path, "$.data.echo");

  const wrong = fakeTransport([
    { status: 200, body: JSON.stringify({ data: { income_rate: 9000, echo: 9000 }, sources: [1, 2] }) },
  ]);
  const fail = await runNode(income, {}, {}, wrong.transport);
  ok("200 with the wrong number is a FAIL", !fail.ok);
  ok("error names the assert", fail.error?.includes("assert.data.income_rate") === true, fail.error);
  ok("and what came back", fail.error?.includes("9000") === true, fail.error);

  const malformed = await runNode(
    { id: "m", type: "api", data: { url: "https://a.test", "assert.x": "~5" } },
    {},
    {},
    fakeTransport([{ status: 200, body: '{"x":5}' }]).transport,
  );
  ok("a malformed assert fails the step", !malformed.ok);

  const statusFirst = await runNode(
    { id: "s", type: "api", data: { url: "https://a.test", expect: "200", "assert.x": "== 1" } },
    {},
    {},
    fakeTransport([{ status: 500, body: '{"x":2}' }]).transport,
  );
  ok("a status failure is reported ahead of an assert", statusFirst.error?.includes("expected 200") === true);
  eq("but the assert still ran", statusFirst.asserts[0]?.ok, false);

  // Same philosophy as `expect`: a failed assert scores red but the walk
  // still follows the drawn edge; --fail-fast stops it.
  const doc = parse(
    `@nodes
  a = api
  Next = page
@node a {
  url: https://a.test
  assert.n: == 1
}
@flow
  a -200> Next
`,
    { strict: false },
  ).doc;
  const walk = await runFlow(doc, { transport: fakeTransport([{ status: 200, body: '{"n":2}' }]).transport });
  eq("a failed assert still walks the edge", walk.steps.map((s) => s.nodeId), ["a", "Next"]);
  ok("and the run is red", !walk.ok);
  const stop = await runFlow(doc, {
    transport: fakeTransport([{ status: 200, body: '{"n":2}' }]).transport,
    stopOnFailure: true,
  });
  eq("--fail-fast stops on a failed assert", stop.steps.map((s) => s.nodeId), ["a"]);
}

// 5d. header assertions — the Flock weak-ETag case -------------------------
{
  const node = {
    id: "media",
    type: "api",
    data: {
      url: "https://a.test/media",
      "assert.header.ETag": 'matches ^"[^"]+"$',
      "assert.header.cache-control": "exists",
      "assert.header.Set-Cookie": "absent",
    },
  };
  const strong = await runNode(
    node,
    {},
    {},
    fakeTransport([{ headers: { etag: '"abc123"', "Cache-Control": "max-age=60" } }]).transport,
  );
  ok("strong ETag passes; header names are case-insensitive", strong.ok, strong.error);

  // The edge rewrote a strong ETag to a weak one — the origin's exact
  // If-None-Match comparison then never matched. A regex catches it.
  const weak = await runNode(
    node,
    {},
    {},
    fakeTransport([{ headers: { ETag: 'W/"abc123"', "cache-control": "no-store" } }]).transport,
  );
  ok("a weakened ETag fails the match", !weak.ok);
  eq("only the ETag assert failed", weak.asserts.map((a) => a.ok), [false, true, true]);

  const leaked = await runNode(
    node,
    {},
    {},
    fakeTransport([{ headers: { ETag: '"a"', "cache-control": "x", "set-cookie": "s=1" } }]).transport,
  );
  ok("absent catches a header that shouldn't be there", !leaked.ok);
  ok("and says what it saw", leaked.error?.includes("s=1") === true, leaked.error);

  const missing = await runNode(node, {}, {}, fakeTransport([{ headers: { ETag: '"a"' } }]).transport);
  ok("exists catches a missing header", missing.asserts[1]?.ok === false);
}

// 5e. conditional GET — capture an ETag, replay it, expect 304 ------------
{
  const SRC = await import("node:fs").then((fs) => fs.readFileSync("examples/conditional-get.fml", "utf8"));
  const doc = parse(SRC, { strict: true }).doc;
  const TAG = '"v1"';

  /** An origin that honours If-None-Match — weakly, as RFC 9110 requires, or not. */
  const origin = (weakCompare: boolean): { transport: Transport; sent: HttpRequest[] } => {
    const sent: HttpRequest[] = [];
    const strip = (t: string): string => (weakCompare ? t.replace(/^W\//, "") : t);
    const transport: Transport = async (req) => {
      sent.push(req);
      const inm = req.headers["If-None-Match"];
      if (inm !== undefined && strip(inm) === TAG) return { status: 304, headers: { ETag: TAG }, body: "" };
      return { status: 200, headers: { ETag: TAG }, body: "{}" };
    };
    return { transport, sent };
  };

  const good = origin(true);
  const pass = await runFlow(doc, { transport: good.transport });
  ok("a correct origin passes the conditional GET flow", pass.ok, pass.steps.find((s) => !s.ok)?.error);
  eq("the captured ETag was replayed verbatim", good.sent[1]?.headers["If-None-Match"], TAG);
  eq("and weakened for the weak replay", good.sent[2]?.headers["If-None-Match"], `W/${TAG}`);

  // The Flock bug: an origin comparing ETags exactly answers 200 to the weak
  // tag an edge rewrote — every client re-downloads. The flow catches it.
  const buggy = await runFlow(doc, { transport: origin(false).transport });
  ok("an exact-match origin fails the weak replay", !buggy.ok);
  eq("at replayWeak", buggy.steps.find((s) => !s.ok)?.nodeId, "replayWeak");
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
