// Usage: node scripts/run.ts <file.fml> [--doc <name>] [--start <nodeId>]
//                            [--var name=value ...] [--dry] [--json] [--fail-fast]
//
// Executes an FML flow for real. Node has no CORS, so this runs today — the
// browser runner is a transport swap away, not a rewrite (see src/fml/run.ts).
//
// Secrets: prefer the environment over --var, which lands in shell history.
// Any `{password}` the file references can be supplied as FML_VAR_password.

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parse, type FmlDoc } from "../src/fml/index.ts";
import {
  buildRequest,
  requiredInputs,
  runFlow,
  type HttpRequest,
  type StepResult,
  type Transport,
} from "../src/fml/run.ts";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
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
// FML_VAR_<name> from the environment, overridden by an explicit --var
const envVars: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("FML_VAR_") && v !== undefined) envVars[k.slice("FML_VAR_".length)] = v;
}

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

const supplied = { ...envVars, ...cliVars };
const needed = requiredInputs(flow).filter((n) => supplied[n] === undefined);
if (needed.length > 0) {
  console.error(`missing run-time input(s): ${needed.join(", ")}`);
  console.error(`supply with  --var ${needed[0]}=…  or  FML_VAR_${needed[0]}=…`);
  process.exit(1);
}

/** Show enough of a secret to prove it flowed, never enough to leak it. */
const SECRETISH = /(token|password|secret|key|auth|bearer|cookie)/i;
function mask(name: string, value: string): string {
  if (!SECRETISH.test(name)) return value;
  return value.length <= 6 ? "•".repeat(value.length) : `${value.slice(0, 4)}…(${value.length})`;
}

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
  return { status: r.status, headers, body: await r.text() };
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
    console.log(`  →  ${node.id}  ${req.method} ${req.url}`);
    for (const [k, v] of Object.entries(req.headers)) console.log(`        ${k}: ${mask(k, v)}`);
    if (req.body) console.log(`        body ${req.body}`);
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
  if (step.passthrough) {
    console.log(`  ·  ${step.nodeId}  (${step.type})`);
    return;
  }
  const mark = step.ok ? "✔" : "✖";
  const req = step.request;
  const head = req ? `${req.method} ${req.url}` : "";
  const status = step.response ? ` → ${step.response.status}` : "";
  const ms = step.durationMs === undefined ? "" : `  ${step.durationMs}ms`;
  console.log(`  ${mark}  ${step.nodeId}  ${head}${status}${ms}`);
  for (const c of step.captures) {
    console.log(
      c.ok
        ? `        capture ${c.name} = ${mask(c.name, c.value ?? "")}`
        : `        capture ${c.name} ✖ nothing at "${c.path}"`,
    );
  }
  for (const a of step.asserts) {
    console.log(
      a.ok
        ? `        assert ${a.label} ✔ ${a.expr}`
        : `        assert ${a.label} ✖ ${a.expr} — ${a.message ?? "failed"}`,
    );
  }
  if (step.error) console.log(`        ${step.error}`);
}

if (dry) {
  printPlan();
  process.exit(0);
}

const run = await runFlow(flow, {
  transport: send,
  vars: supplied,
  ...(flag("start") ? { start: flag("start")! } : {}),
  stopOnFailure: has("fail-fast"),
  onStep: asJson ? undefined : line,
});

if (asJson) {
  console.log(JSON.stringify(run, null, 2));
} else {
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
