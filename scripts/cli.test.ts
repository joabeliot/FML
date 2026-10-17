// Usage: node scripts/cli.test.ts
//
// The command-line tools as a user runs them — real processes, real flags,
// real exit codes — against a local fixture server (scripts/testkit), so
// nothing here needs the internet. Covers scripts/run.ts (flags, inputs,
// secrets + redaction, reports, fail-fast), scripts/drift.ts and
// scripts/demo.ts. ui steps need a browser and live in the e2e suite.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASSWORD, SPEC, TOKEN, startFixture } from "./testkit/fixtureServer.ts";

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

interface Ran {
  code: number;
  out: string;
  err: string;
}

/** Run a script as a separate process. Async, so the fixture server keeps serving. */
function cli(script: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    if (input !== undefined) child.stdin.end(input);
  });
}

const fx = await startFixture();
const dir = mkdtempSync(join(tmpdir(), "fml-cli-"));
const FLOW = join(dir, "login.fml");
writeFileSync(
  FLOW,
  `@meta
  base: {apiBase}

@nodes
  login  = api
  me     = api
  Home   = page
  Denied = page

@node login {
  method: POST
  path: /login
  body: {"password":"{password}"}
  capture.token: $.token
  capture.name: $.user.name
  expect: 200
}

@node me {
  path: /me
  auth: bearer {token}
  expect: 200
  assert.name: Ada
  assert.echo: exists
}

@flow
  login:
    -200> me
    -401> Denied
  me -200> Home
`,
);
const base = { FML_VAR_apiBase: fx.url };
const run = (args: string[], env: Record<string, string> = {}) => cli("scripts/run.ts", [FLOW, ...args], { ...base, ...env });

try {
  // 1. a passing run ---------------------------------------------------------
  {
    const r = await run([], { FML_SECRET_password: PASSWORD });
    ok("a passing flow exits 0", r.code === 0, r.out + r.err);
    ok("and says PASS", r.out.includes("PASS"));
    ok("the captured token never appears in the log", !r.out.includes(TOKEN));
    ok("nor the password", !r.out.includes(PASSWORD));
    ok("the redaction says what was hidden", r.out.includes("[redacted:"));
    ok("the non-secret capture is shown", r.out.includes("capture name = Ada"));
  }

  // 2. inputs ------------------------------------------------------------------
  {
    const missing = await run([]);
    ok("a missing run-time input exits 1 before sending", missing.code === 1 && missing.err.includes("password"), missing.err);
    ok("…and nothing was sent", (fx.hits.get("POST /login") ?? 0) === 1);
    const viaVar = await run(["--var", `password=${PASSWORD}`]);
    ok("--var supplies an input", viaVar.code === 0, viaVar.out);
    const viaEnv = await run([], { FML_VAR_password: PASSWORD });
    ok("FML_VAR_ supplies an input", viaEnv.code === 0, viaEnv.out);
  }

  // 3. secrets files ------------------------------------------------------------
  {
    writeFileSync(join(dir, ".fml.env"), `# local secrets\npassword=${PASSWORD}\n`);
    const auto = await run([]);
    ok(".fml.env beside the flow is loaded automatically", auto.code === 0, auto.out + auto.err);
    ok("and its values are redacted", !auto.out.includes(PASSWORD));
    rmSync(join(dir, ".fml.env"));

    const explicit = join(dir, "other.env");
    writeFileSync(explicit, `export password="${PASSWORD}"\n`);
    const viaFlag = await run(["--secrets", explicit]);
    ok("--secrets <file> is loaded", viaFlag.code === 0, viaFlag.out + viaFlag.err);
    const gone = await run(["--secrets", join(dir, "nope.env")]);
    ok("a --secrets path that doesn't exist is an error, not a silent no-op", gone.code === 1 && gone.err.includes("no secrets file"));
    writeFileSync(explicit, "this is not name=value\n= x\n");
    const bad = await run(["--secrets", explicit]);
    ok("a malformed secrets file is an error with line numbers", bad.code === 1 && bad.err.includes("line "), bad.err);
  }

  // 4. --dry --------------------------------------------------------------------
  {
    const before = fx.hits.get("POST /login") ?? 0;
    const dry = await run(["--dry"], { FML_SECRET_password: PASSWORD });
    ok("--dry exits 0 and prints the plan", dry.code === 0 && dry.out.includes("PLAN"), dry.out);
    ok("…with the resolved request", dry.out.includes(`POST ${fx.url}/login`));
    ok("…redacting secrets in bodies", !dry.out.includes(PASSWORD));
    ok("…and sends nothing", (fx.hits.get("POST /login") ?? 0) === before);
  }

  // 5. failures, --fail-fast, the JSON report ------------------------------------
  {
    const wrong = await run(["--json"], { FML_SECRET_password: "wrong-password-x" });
    ok("a failing flow exits 1", wrong.code === 1);
    const report = JSON.parse(wrong.out) as {
      schema: number;
      ok: boolean;
      failure?: { kind: string; nodeId: string };
      steps: Array<{ nodeId: string }>;
    };
    ok("--json prints the report (schema 1)", report.schema === 1 && report.ok === false);
    ok("the failure is classified", report.failure?.kind === "status" && report.failure?.nodeId === "login", JSON.stringify(report.failure));
    ok("a failed status still walks its drawn edge", report.steps.map((s) => s.nodeId).join() === "login,Denied");
    ok("the wrong password is redacted in the report too", !wrong.out.includes("wrong-password-x"));

    const fast = await run(["--json", "--fail-fast"], { FML_SECRET_password: "wrong-password-x" });
    const fastReport = JSON.parse(fast.out) as { steps: Array<{ nodeId: string }>; stoppedBecause: string };
    ok("--fail-fast stops at the failure", fastReport.steps.length === 1 && fastReport.stoppedBecause === "failed");

    const path = join(dir, "report.json");
    const both = await run(["--report", path], { FML_SECRET_password: PASSWORD });
    ok("--report writes the file", existsSync(path) && JSON.parse(readFileSync(path, "utf8")).ok === true);
    ok("…and keeps the human log", both.out.includes("PASS"));
    ok("…with no secret in the file", !readFileSync(path, "utf8").includes(TOKEN));
  }

  // 6. drift ------------------------------------------------------------------------
  {
    const json = join(dir, "spec.json");
    writeFileSync(json, JSON.stringify({ ...SPEC, servers: [{ url: fx.url }] }));
    const clean = await cli("scripts/drift.ts", [FLOW, json]);
    ok("drift: a flow matching its spec exits 0", clean.code === 0 && clean.out.includes("OK"), clean.out + clean.err);

    const yaml = join(dir, "spec.yaml");
    writeFileSync(yaml, "openapi: 3.0.3\npaths:\n  /login:\n    post:\n      responses:\n        '200': {}\n");
    const drifted = await cli("scripts/drift.ts", [FLOW, yaml, "--json"]);
    const report = JSON.parse(drifted.out) as { findings: Array<{ nodeId: string; kind: string }> };
    ok("drift reads YAML", drifted.out.trim().startsWith("{"));
    ok("drift: a path missing from the spec exits 1", drifted.code === 1);
    ok(
      "…naming the node and the kind",
      report.findings.some((f) => f.nodeId === "me" && f.kind === "unknown-path") &&
        report.findings.some((f) => f.nodeId === "login" && f.kind === "undocumented-status"),
      JSON.stringify(report.findings),
    );
    const cov = await cli("scripts/drift.ts", [FLOW, json, "--coverage"]);
    ok("drift --coverage runs", cov.code === 0);
    const usage = await cli("scripts/drift.ts", [FLOW]);
    ok("drift with no spec prints usage and exits 2", usage.code === 2 && usage.err.includes("usage"));
  }

  // 7. asking a person mid-run (FML-26) ------------------------------------------------
  {
    const asking = join(dir, "asking.fml");
    writeFileSync(
      asking,
      readFileSync(FLOW, "utf8").replace("  path: /login\n", "  path: /login\n  ask.password: Your password\n  pause: About to sign in\n"),
    );
    const ask = (args: string[], env: Record<string, string> = {}, input?: string) =>
      cli("scripts/run.ts", [asking, ...args], { ...base, ...env }, input);

    const piped = await ask([], { FML_ASK: "stdin" }, `\n${PASSWORD}\n`);
    ok("an asked value typed in carries the run", piped.code === 0, piped.out + piped.err);
    ok("…the prompt goes to stderr", piped.err.includes("Your password") && !piped.out.includes("Your password"), piped.err);
    ok("…the step log says it was asked", piped.out.includes("{password} given after"), piped.out);
    ok("…and the answer is redacted", !piped.out.includes(PASSWORD) && !piped.err.includes(PASSWORD));

    const stop = await ask([], { FML_ASK: "stdin" }, "q\n");
    ok("q at a pause stops the run", stop.code === 1 && stop.out.includes("stopped: cancelled"), stop.out + stop.err);
    ok("…before anything was sent", stop.out.includes(`Stopped at "login"`), stop.out);

    const ci = await ask([]);
    ok("non-interactive, a pause fails the step", ci.code === 1 && ci.out.includes("--yes"), ci.out);
    const yes = await ask(["--yes"]);
    ok("--yes gets past the pause, but the value is still missing", yes.code === 1 && yes.out.includes("--var password="), yes.out);
    const upFront = await ask(["--yes", "--var", `password=${PASSWORD}`]);
    ok("--yes with the value up front runs without asking", upFront.code === 0 && !upFront.err.includes("Your password"), upFront.out + upFront.err);

    const json = await ask(["--json"], { FML_ASK: "stdin" }, `\n${PASSWORD}\n`);
    const report = JSON.parse(json.out) as { ok: boolean; steps: Array<{ asked?: Array<{ kind: string; name?: string }> }> };
    ok("--json stays parseable while asking", report.ok);
    ok("…and records what was asked, not the answer", JSON.stringify(report.steps[0]?.asked?.map((a) => a.name ?? a.kind)) === '["confirm","password"]' && !json.out.includes(PASSWORD), json.out);
  }

  // 8. demo (the structural check) -------------------------------------------------
  {
    const bad = join(dir, "bad.fml");
    writeFileSync(bad, "@nodes\n  a = api\n@node a {\n  path: /x\n  heder.Accept: y\n}\n");
    const d = await cli("scripts/demo.ts", [bad]);
    ok("demo flags a typo'd key", d.out.includes(`"heder.Accept" isn't part of the api standard`), d.out);
    ok("demo flags a path with no base", d.out.includes('has a "base"'), d.out);
    const broken = join(dir, "broken.fml");
    writeFileSync(broken, "@nodes\n  a = api\n@flow\n  a -x> \n");
    const e = await cli("scripts/demo.ts", [broken]);
    ok("demo reports a parse error with its line", e.out.includes("ok: false") && e.out.includes("line 4"), e.out);
  }
} finally {
  await fx.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
