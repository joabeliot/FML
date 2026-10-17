// Usage: node scripts/run.ts <file.fml> [--doc <name>] [--start <nodeId>]
//                            [--var name=value ...] [--dry] [--fail-fast]
//                            [--json] [--report <out.json>]
//
// --json prints the machine-readable run report (src/fml/report.ts) instead
// of the step log; --report writes the same report to a file and keeps the
// log on screen. Either way secrets are redacted and the exit code is 0/1.
//
// Executes an FML flow for real. Node has no CORS, so this runs today — the
// browser runner is a transport swap away, not a rewrite (see src/fml/run.ts).
//
// Run-time inputs, lowest precedence first:
//   .fml.env beside the flow, or --secrets <file>   (gitignored dotenv file)
//   FML_VAR_<name>     a plain input from the environment
//   FML_SECRET_<name>  the same, but always redacted from output
//   --var name=value   lands in shell history — fine for non-secrets
// Everything from a secrets file or FML_SECRET_ is redacted by value from the
// log, the plan and the report; so is any variable with a secret-looking name.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parse, type FmlDoc } from "../src/fml/index.ts";
import { buildReport, collectSecrets, makeRedactor, type Redactor } from "../src/fml/report.ts";
import { parseSecretsFile } from "../src/fml/secrets.ts";
import {
  buildRequest,
  requiredInputs,
  runFlow,
  type HttpRequest,
  type StepResult,
  type Transport,
} from "../src/fml/run.ts";

const args = process.argv.slice(2);
// Flags that take a value — their value is not a positional argument.
const VALUE_FLAGS = new Set(["--doc", "--start", "--var", "--report", "--secrets"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name: string): boolean => args.includes(`--${name}`);

const file = positional[0] ?? "examples/auth.fml";
const dry = has("dry");
const asJson = has("json");

// --var name=value, repeatable
const cliVars: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--var") continue;
  const pair = args[i + 1] ?? "";
  const eq = pair.indexOf("=");
  if (eq > 0) cliVars[pair.slice(0, eq)] = pair.slice(eq + 1);
}
// FML_VAR_<name> / FML_SECRET_<name> from the environment, overridden by --var
const envVars: Record<string, string> = {};
const envSecrets: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (k.startsWith("FML_VAR_")) envVars[k.slice("FML_VAR_".length)] = v;
  else if (k.startsWith("FML_SECRET_")) envSecrets[k.slice("FML_SECRET_".length)] = v;
}

// A secrets file: --secrets <path>, else a .fml.env beside the flow if there is one.
const explicitSecrets = flag("secrets");
const secretsPath = explicitSecrets ?? resolvePath(dirname(resolvePath(file)), ".fml.env");
const fileSecrets: Record<string, string> = {};
if (explicitSecrets !== undefined && !existsSync(secretsPath)) {
  console.error(`no secrets file at ${secretsPath}`);
  process.exit(1);
}
if (existsSync(secretsPath)) {
  const parsed = parseSecretsFile(readFileSync(secretsPath, "utf8"));
  if (parsed.issues.length > 0) {
    console.error(`${secretsPath} has errors:`);
    for (const i of parsed.issues) console.error(`  line ${i.line}: ${i.message}`);
    process.exit(1);
  }
  Object.assign(fileSecrets, parsed.values);
}
/** Values that are secret by declaration, whatever they're called. */
const declaredSecrets: Record<string, string> = { ...fileSecrets, ...envSecrets };

const dirOf = new Map<string, string>();
const resolve = (path: string, from: string | undefined): string | undefined => {
  const baseDir =
    from === undefined ? dirname(resolvePath(file)) : (dirOf.get(from) ?? dirname(resolvePath(file)));
  const target = resolvePath(baseDir, path.endsWith(".fml") ? path : `${path}.fml`);
  try {
    const content = readFileSync(target, "utf8");
    dirOf.set(path, dirname(target));
    return content;
  } catch {
    return undefined;
  }
};

const res = parse(readFileSync(file, "utf8"), { resolve });
if (res.errors.length > 0) {
  console.error(`${file} has errors:`);
  for (const e of res.errors) console.error(`  line ${e.line}: ${e.message}`);
  process.exit(1);
}

const docName = flag("doc");
const doc = docName ? res.file.docs.find((d) => d.name === docName) : res.file.docs[0];
if (!doc) {
  console.error(`no doc named "${docName}" — have: ${res.file.docs.map((d) => d.name).join(", ")}`);
  process.exit(1);
}

// Narrowed alias — `doc` is optional until the guard above, and TS can't carry
// that narrowing into the functions below.
const flow: FmlDoc = doc;

const supplied = { ...fileSecrets, ...envVars, ...envSecrets, ...cliVars };
const needed = requiredInputs(flow).filter((n) => supplied[n] === undefined);
if (needed.length > 0) {
  console.error(`missing run-time input(s): ${needed.join(", ")}`);
  console.error(`supply with  --var ${needed[0]}=…  or  FML_VAR_${needed[0]}=…`);
  process.exit(1);
}

/**
 * Every value known to be secret so far — declared ones, secret-looking
 * supplied ones, and secret-looking captures as the run produces them — and
 * a redactor over them, rebuilt as captures land.
 */
const liveSecrets: Record<string, string> = collectSecrets(supplied, declaredSecrets);
let redact: Redactor = makeRedactor(liveSecrets);
function learnSecrets(vars: Record<string, string>): void {
  const before = Object.keys(liveSecrets).length;
  Object.assign(liveSecrets, collectSecrets(vars, liveSecrets));
  if (Object.keys(liveSecrets).length !== before) redact = makeRedactor(liveSecrets);
}
const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key)$/i;
const showHeader = (name: string, value: string): string => (SECRET_HEADERS.test(name) ? "[redacted]" : redact(value));

const send: Transport = async (req: HttpRequest, signal?: AbortSignal) => {
  const r = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body === undefined ? {} : { body: req.body }),
    ...(signal ? { signal } : {}),
  });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, headers, body: new TextDecoder().decode(bytes), bytes };
};

/**
 * `--dry` isn't a run with a fake transport — a fabricated status would fail
 * every `expect` and stop at the first node, which tells you nothing. It's a
 * plan: every request this doc would send, fully interpolated, in doc order.
 */
function printPlan(): void {
  let unresolved = 0;
  for (const node of flow.nodes) {
    if (node.type !== "api") continue;
    const built = buildRequest(node, flow.meta, { ...flow.vars, ...supplied });
    if (built.error) {
      console.log(`  ✖  ${node.id}  ${built.error}`);
      unresolved++;
      continue;
    }
    const req = built.request!;
    console.log(`  →  ${node.id}  ${req.method} ${redact(req.url)}`);
    for (const [k, v] of Object.entries(req.headers)) console.log(`        ${k}: ${showHeader(k, v)}`);
    if (req.body) console.log(`        body ${redact(req.body)}`);
    for (const [k, v] of Object.entries(node.data)) {
      if (k.startsWith("capture.")) console.log(`        capture ${k.slice(8)} ← ${v}`);
      else if (k.startsWith("assert.")) console.log(`        assert ${k.slice(7)}: ${v}`);
    }
    if (built.missing.length > 0) {
      // Not an error here: these are captured mid-run, so they're unknowable
      // until the earlier request actually goes out.
      console.log(`        pending: ${built.missing.map((n) => `{${n}}`).join(", ")}`);
    }
  }
  console.log(`\nPLAN  ${flow.name}  —  nothing sent${unresolved > 0 ? `, ${unresolved} node(s) can't build a request` : ""}`);
}

function line(step: StepResult): void {
  const captured: Record<string, string> = {};
  for (const c of step.captures) if (c.value !== undefined) captured[c.name] = c.value;
  learnSecrets(captured);
  if (step.passthrough) {
    console.log(`  ·  ${step.nodeId}  (${step.type})`);
    return;
  }
  const mark = step.ok ? "✔" : "✖";
  const req = step.request;
  const head = req ? `${req.method} ${redact(req.url)}` : "";
  const status = step.response ? ` → ${step.response.status}` : "";
  const ms = step.durationMs === undefined ? "" : `  ${step.durationMs}ms`;
  console.log(`  ${mark}  ${step.nodeId}  ${head}${status}${ms}`);
  for (const c of step.captures) {
    console.log(
      c.ok
        ? `        capture ${c.name} = ${redact(c.value ?? "")}`
        : `        capture ${c.name} ✖ nothing at "${c.path}"`,
    );
  }
  for (const a of step.asserts) {
    console.log(
      a.ok
        ? `        assert ${a.label} ✔ ${a.expr}`
        : `        assert ${a.label} ✖ ${a.expr} — ${redact(a.message ?? "failed")}`,
    );
  }
  if (step.error) console.log(`        ${redact(step.error)}`);
}

if (dry) {
  printPlan();
  process.exit(0);
}

const startedAt = new Date();
const run = await runFlow(flow, {
  transport: send,
  vars: supplied,
  ...(flag("start") ? { start: flag("start")! } : {}),
  stopOnFailure: has("fail-fast"),
  onStep: asJson ? undefined : line,
});

const reportPath = flag("report");
if (asJson || reportPath) {
  const report = buildReport(run, {
    doc: flow.name,
    file,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    secrets: collectSecrets({ ...supplied, ...run.vars }, declaredSecrets),
  });
  const text = JSON.stringify(report, null, 2);
  if (reportPath) writeFileSync(reportPath, `${text}\n`);
  if (asJson) console.log(text);
}

if (!asJson) {
  console.log(
    `\n${run.ok ? "PASS" : "FAIL"}  ${flow.name}  —  ${run.steps.filter((s) => !s.passthrough).length} request(s), stopped: ${run.stoppedBecause}`,
  );
  if (run.stoppedBecause === "unmodelled") {
    console.log(
      `  "${run.ambiguousAt}" returned ${run.unmodelledStatus} and no edge leaves it for that status.`,
    );
    console.log(`  Draw a -${run.unmodelledStatus}> branch to carry the run on from there.`);
  } else if (run.ambiguousAt) {
    console.log(`  "${run.ambiguousAt}" has several outgoing edges and no status to pick one.`);
  }
}

process.exit(run.ok ? 0 : 1);
