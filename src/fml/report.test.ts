// Usage: node src/fml/report.test.ts
//
// The JSON run report and its redaction — driven by real runs over a fake
// transport, so the report is tested against what the engine actually emits.

import { parse } from "./index.ts";
import { buildReport, collectSecrets, makeRedactor } from "./report.ts";
import { runFlow, type HttpResponse, type Transport } from "./run.ts";

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

function answers(list: Array<Partial<HttpResponse>>): Transport {
  let i = 0;
  return async () => {
    const r = list[Math.min(i++, list.length - 1)] ?? {};
    return { status: r.status ?? 200, headers: r.headers ?? {}, body: r.body ?? "" };
  };
}

const SRC = `
@meta
  base: https://api.test

@nodes
  login = api
  me    = api
  Home  = page
  Nope  = page

@node login {
  method: POST
  path: /login
  body: {"password":"{password}"}
  capture.access: $.access
  expect: 200
}

@node me {
  path: /me?key={apiKey}
  auth: bearer {access}
  expect: 200
  assert.plan: pro
}

@flow
  login:
    -200> me
    -401> Nope
  me -200> Home
`;
const doc = parse(SRC, { strict: false }).doc;
const supplied = { password: "hunter2-very-secret", apiKey: "k-123456" };

// 1. redaction primitives ---------------------------------------------------
{
  const redact = makeRedactor({ token: "abcd1234", short: "ab" });
  eq("value scrubbed wherever it appears", redact("x abcd1234 y abcd1234"), "x [redacted:token] y [redacted:token]");
  eq("very short values are left alone", redact("ab"), "ab");
  const nested = makeRedactor({ outer: "secret-plus-more", inner: "secret" });
  eq("longest secret wins", nested("secret-plus-more"), "[redacted:outer]");
  eq("secret-looking names are collected", Object.keys(collectSecrets({ authToken: "x", userId: "1" })), ["authToken"]);
  eq("explicit secrets are kept", collectSecrets({}, { access: "zzzz" }), { access: "zzzz" });
}

// 2. a failing assert -----------------------------------------------------
{
  const run = await runFlow(doc, {
    transport: answers([
      { status: 200, body: JSON.stringify({ access: "tok-SHOULD-NOT-LEAK" }) },
      { status: 200, body: JSON.stringify({ plan: "free", echo: "tok-SHOULD-NOT-LEAK" }) },
    ]),
    vars: supplied,
  });
  const report = buildReport(run, {
    doc: doc.name,
    file: "x.fml",
    durationMs: 12,
    secrets: collectSecrets({ ...supplied, ...run.vars }, { access: run.vars.access ?? "" }),
  });
  const text = JSON.stringify(report);

  eq("schema version", report.schema, 1);
  eq("red", report.ok, false);
  eq("summary", report.summary, { steps: 3, requests: 2, passed: 1, failed: 1 });
  eq("failure points at the node", report.failure?.nodeId, "me");
  eq("and says it was an assert", report.failure?.kind, "assert");
  eq("with the assertion that failed", report.failure?.assertion?.label, "plan");
  eq("and what came back", report.failure?.assertion?.actual, "free");
  eq("the failing response is attached", report.failure?.response?.status, 200);
  ok("password never appears", !text.includes("hunter2-very-secret"));
  ok("api key scrubbed from the URL", report.steps[1]?.request?.url === "https://api.test/me?key=[redacted:apiKey]");
  ok("captured token never appears — not even echoed in a body", !text.includes("tok-SHOULD-NOT-LEAK"));
  eq("Authorization is always hidden", report.steps[1]?.request?.headers.Authorization, "[redacted]");
  ok("timings carried", report.durationMs === 12 && typeof report.steps[1]?.durationMs === "number");
}

// 3. each failure kind ----------------------------------------------------
{
  const kindOf = async (list: Array<Partial<HttpResponse>>): Promise<string | undefined> => {
    const run = await runFlow(doc, { transport: answers(list), vars: supplied });
    return buildReport(run, { doc: doc.name }).failure?.kind;
  };
  eq("status", await kindOf([{ status: 401, body: "{}" }]), "status");
  eq("capture", await kindOf([{ status: 200, body: "{}" }]), "capture");

  const branchy = parse(`@nodes\n  a = api\n  b = page\n  c = page\n@node a {\n  url: https://a.test\n}\n@flow\n  a:\n    -200> b\n    -404> c\n`, {
    strict: false,
  }).doc;
  const unmodelled = await runFlow(branchy, { transport: answers([{ status: 500 }]) });
  const r = buildReport(unmodelled, { doc: "x" });
  eq("a status with no edge is its own kind", r.failure?.kind, "unmodelled");
  ok("and names the status", r.failure?.message.includes("500") === true, r.failure?.message);

  const dead = parse(`@nodes\n  a = api\n@node a {\n  path: /x\n}\n`, { strict: false }).doc;
  const noBase = buildReport(await runFlow(dead, { transport: answers([{}]) }), { doc: "x" });
  eq("no request at all", noBase.failure?.kind, "request");

  const pass = await runFlow(doc, {
    transport: answers([
      { status: 200, body: JSON.stringify({ access: "t0k-t0k" }) },
      { status: 200, body: JSON.stringify({ plan: "pro" }) },
    ]),
    vars: supplied,
  });
  const green = buildReport(pass, { doc: doc.name });
  eq("a pass has no failure", green.failure, undefined);
  eq("and is ok", green.ok, true);
}

// 4. big bodies are truncated, not dropped ---------------------------------
{
  const big = "x".repeat(100);
  const one = parse(`@nodes\n  a = api\n@node a {\n  url: https://a.test\n}\n`, { strict: false }).doc;
  const run = await runFlow(one, { transport: answers([{ body: big }]) });
  const r = buildReport(run, { doc: "x", maxBodyChars: 10 });
  eq("body cut to the limit", r.steps[0]?.response?.body.length, 10);
  eq("flagged as truncated", r.steps[0]?.response?.bodyTruncated, true);
  eq("original size kept", r.steps[0]?.response?.bodyBytes, 100);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
