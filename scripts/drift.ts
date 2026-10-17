// Usage: node scripts/drift.ts <file.fml> <openapi.json|yaml> [--json] [--coverage]
//
// Compares every `api` node in a flow file (and its @fof imports) with an
// OpenAPI 3.x / Swagger 2.0 spec — see src/fml/drift.ts. Exit code 1 when
// there's an error-level finding (a path or method the spec doesn't have),
// so it works as a CI check next to the run itself. Warnings (undocumented
// statuses) are printed but don't fail it.
//
// --json      the full report on stdout
// --coverage  also list the spec operations no flow exercises

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { parse } from "../src/fml/index.ts";
import { checkDrift } from "../src/fml/drift.ts";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const asJson = args.includes("--json");
const showCoverage = args.includes("--coverage");

const [file, specPath] = positional;
if (!file || !specPath) {
  console.error("usage: node scripts/drift.ts <file.fml> <openapi.json|yaml> [--json] [--coverage]");
  process.exit(2);
}

const specText = readFileSync(specPath, "utf8");
let spec: unknown;
try {
  // YAML is a superset of JSON, so one parser reads both.
  spec = parseYaml(specText);
} catch (err) {
  console.error(`${specPath} isn't valid JSON or YAML — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
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
  process.exit(2);
}

const report = checkDrift(res.file.docs, spec);
const errors = report.findings.filter((f) => f.severity === "error");

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const f of report.findings) {
    const mark = f.severity === "error" ? "✖" : "!";
    const where = res.file.docs.length > 1 ? `${f.doc}/` : "";
    console.log(`  ${mark}  ${where}${f.nodeId}  ${f.message}`);
  }
  if (report.skipped.length > 0) {
    const hosts = [...new Set(report.skipped.map((x) => x.origin))].join(", ");
    console.log(`  ·  skipped ${report.skipped.length} node(s) on another host (${hosts})`);
  }
  const { total, exercised, unexercised } = report.coverage;
  if (showCoverage && unexercised.length > 0) {
    console.log(`\n  not exercised by any flow:`);
    for (const op of unexercised) console.log(`     ${op}`);
  }
  const warnings = report.findings.length - errors.length;
  console.log(
    `\n${errors.length > 0 ? "DRIFT" : "OK"}  ${errors.length} error(s), ${warnings} warning(s) — ${exercised.length}/${total} spec operations exercised`,
  );
}

process.exit(errors.length > 0 ? 1 : 0);
