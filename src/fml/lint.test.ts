// Usage: node src/fml/lint.test.ts
import { parse } from "./index.ts";
import { lintDoc, type LintIssue } from "./lint.ts";

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

const lintOf = (src: string): LintIssue[] => lintDoc(parse(src, { strict: false }).doc);
const has = (issues: LintIssue[], nodeId: string, needle: string): boolean =>
  issues.some((i) => i.nodeId === nodeId && i.message.includes(needle));

// 1. the typo catcher — the actual point of standardising the key set
{
  const issues = lintOf(
    `@meta\n  base: https://a.test\n@nodes\n  a = api\n@node a {\n  method: GET\n  path: /x\n  heder.Accept: application/json\n}\n`,
  );
  ok("a mistyped dotted key is flagged", has(issues, "a", "isn't part of the api standard"));
  ok("it names the key", issues.some((i) => i.key === "heder.Accept"));

  const clean = lintOf(
    `@meta\n  base: https://a.test\n@nodes\n  a = api\n@node a {\n  method: GET\n  path: /x\n  header.Accept: application/json\n  query.page: 2\n  capture.id: $.id\n  expect: 200\n}\n`,
  );
  eq("a correct api node is silent", clean, []);
}

// 2. things that cannot run
{
  // A bare sketch is a warning — "a sketch should stay cheap to write".
  const sketch = lintOf(`@nodes\n  a = api\n@node a {\n  method: GET\n}\n`);
  eq("a sketchy api node is a warning, not an error", sketch[0]?.severity, "warning");

  // But detail with nowhere to send it is a genuine contradiction.
  const meantIt = lintOf(`@nodes\n  a = api\n@node a {\n  method: POST\n  body: {"a":1}\n  expect: 200\n}\n`);
  ok("request detail with no target is an error", meantIt.some((i) => i.severity === "error"));

  const noBase = lintOf(`@nodes\n  a = api\n@node a {\n  path: /x\n}\n`);
  ok("relative path with no base is flagged", has(noBase, "a", "neither this node nor the doc has a \"base\""));
  eq("as a warning — plenty of docs are only ever drawings", noBase[0]?.severity, "warning");

  const withBase = lintOf(`@meta\n  base: https://a.test\n@nodes\n  a = api\n@node a {\n  path: /x\n}\n`);
  eq("...and fine once a base exists", withBase.length, 0);

  const absolutePath = lintOf(`@nodes\n  a = api\n@node a {\n  path: https://a.test/x\n}\n`);
  eq("an absolute path needs no base", absolutePath.length, 0);

  // A node's own `base` satisfies this even with no `@meta base` at all —
  // the multi-host case (auth.example.com vs. api.example.com in one file).
  const nodeBase = lintOf(`@nodes\n  a = api\n@node a {\n  base: https://auth.test\n  path: /x\n}\n`);
  eq("a node-level base is also fine, no @meta base needed", nodeBase.length, 0);
}

// 3. malformed execution values
{
  const bad = lintOf(
    `@meta\n  base: https://a.test\n@nodes\n  a = api\n@node a {\n  method: FETCH\n  path: /x\n  expect: twohundred\n  capture.empty:\n}\n`,
  );
  ok("bad method", has(bad, "a", "isn't a standard HTTP method"));
  ok("bad expect", has(bad, "a", "isn't a status pattern"));
  ok("empty capture path", has(bad, "a", "never capture anything"));

  const good = lintOf(
    `@meta\n  base: https://a.test\n@nodes\n  a = api\n@node a {\n  method: patch\n  path: /x\n  expect: 2xx\n}\n`,
  );
  eq("lowercase method and a wildcard expect are fine", good.length, 0);
}

// 4. run-time inputs are stated, not scolded
{
  const issues = lintOf(
    `@meta\n  base: https://a.test\n@nodes\n  a = api\n@node a {\n  path: /x\n  header.Authorization: Bearer {token}\n}\n`,
  );
  ok("unsupplied variable reported", has(issues, "a", "run-time input"));
  eq("as info, not a fault", issues[0]?.severity, "info");

  const captured = lintOf(
    `@meta\n  base: https://a.test\n@nodes\n  a = api\n  b = api\n@node a {\n  path: /login\n  capture.token: $.t\n}\n@node b {\n  path: /me\n  auth: bearer {token}\n}\n`,
  );
  eq("a captured variable is not an input", captured.length, 0);
}

// 5. expect + a drawn status edge is the idiom, NOT a contradiction
{
  const issues = lintOf(
    `@meta\n  base: https://a.test\n@nodes\n  a = api\n  ok = page\n  bad = page\n@node a {\n  path: /x\n  expect: 200\n}\n@flow\n  a:\n    -200> ok\n    -404> bad\n`,
  );
  // auth.fml, app.fml and run.fml all write it this way. `expect` asserts the
  // happy path; the edges map every outcome. Flagging it was noise.
  eq("drawing the error branch is never flagged", issues, []);
}

// 6. every shipped example lints clean
{
  const clean = ["examples/run.fml"];
  for (const file of clean) {
    // Read through parse so @meta/@vars are real; no @fof in these.
    const src = await import("node:fs").then((fs) => fs.readFileSync(file, "utf8"));
    const issues = lintDoc(parse(src, { strict: true }).doc).filter((i) => i.severity !== "info");
    eq(`${file} lints clean`, issues, []);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
