// Usage: node src/rml/rml.test.ts
import { readFileSync } from "node:fs";
import { parse } from "../fml/index.ts";
import { checkRoadmap, displayStates, progress, refsOf, RML_VOCABULARY, statusOf } from "./rml.ts";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: string) => {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const eq = <T,>(name: string, actual: T, expected: T) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `got ${a}, want ${e}`);
};

const rml = (src: string) => parse(src, { strict: true, vocabulary: RML_VOCABULARY });

// 1. the grammar is FML's, the vocabulary is RML's -----------------------------
{
  const res = rml(`@nodes\n  a = feature\n  b = milestone\n@flow\n  a -> b\n`);
  eq("feature and milestone are the standard", [res.errors, res.warnings], [[], []]);
  const fmlTypes = rml(`@nodes\n  a = page\n`);
  ok("an FML type is foreign here (strict: an error)", fmlTypes.errors.some((e) => e.message.includes("feature, milestone")));
  const fmlStill = parse(`@nodes\n  a = page\n`);
  eq("and FML's own default vocabulary is untouched", fmlStill.errors, []);
}

// 2. status and display ----------------------------------------------------
{
  const doc = rml(`@nodes
  a = feature
  b = feature
  c = feature
  d = milestone
  e = feature
@node a {
  status: done
}
@node b {
  status: active
}
@node e {
  status: DONE
}
@flow
  a -> c
  a -> d
  b -> d
`).doc;
  eq("status defaults to pending, case-insensitive", doc.nodes.map(statusOf), ["done", "active", "pending", "pending", "done"]);
  eq("display: ready when every dependency is done, locked otherwise", Object.fromEntries(displayStates(doc)), {
    a: "done",
    b: "active",
    c: "ready",
    d: "locked",
    e: "done",
  });
  eq("progress counts done nodes", progress(doc), { done: 2, total: 5 });
}

// 3. checks ------------------------------------------------------------------
{
  const doc = rml(`@nodes
  a = feature
  b = feature
  c = feature
@node a {
  status: finished
  owner: jb
}
@flow
  a -> b
  b -> c
  c -> a
`).doc;
  const msgs = checkRoadmap(doc).map((i) => i.message);
  ok("a bad status is flagged", msgs.some((m) => m.includes(`"finished"`)));
  ok("an unknown key is flagged", msgs.some((m) => m.includes(`"owner"`)));
  ok("a dependency cycle is flagged once", msgs.filter((m) => m.startsWith("dependency cycle")).length === 1, JSON.stringify(msgs));
}

// 4. references ----------------------------------------------------------------
{
  eq("comma or space separated", refsOf("FML-11, FML-12 FML-13"), ["FML-11", "FML-12", "FML-13"]);
  eq("absent is empty", refsOf(undefined), []);
}

// 5. the shipped example ------------------------------------------------------
{
  const res = rml(readFileSync("examples/roadmap.rml", "utf8"));
  eq("examples/roadmap.rml parses clean under strict", [res.errors, res.warnings], [[], []]);
  eq("and passes the roadmap checks", checkRoadmap(res.doc), []);
  const shown = displayStates(res.doc);
  eq("its frontier is what's actually next", [...shown].filter(([, s]) => s === "ready").map(([id]) => id).sort(), ["liveSync", "stagingGate", "uiSteps"]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
