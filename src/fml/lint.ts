// FML — semantic checks on a parsed doc.
//
// The parser answers "is this well-formed?". This answers "will this actually
// do what it looks like it does?" — the class of mistake you'd otherwise only
// find when a run fails at 2am: a typo'd `heder.Accept` that silently never
// sends, a `path` with no `base` to hang off, an `expect: twohundred`.
//
// Issues are keyed by node id rather than line number, because that's what the
// canvas and the property panel can act on — a node they can highlight.
//
// Zero dependencies, like the rest of `src/fml/`.

import { EXEC_KEY_PREFIXES, isKnownType, nodeTypeSpec } from "./nodeTypes.ts";
import { isStatusLabel } from "./run.ts";
import type { FmlDoc } from "./types.ts";
import { varsInValue } from "./variables.ts";

export type LintSeverity = "error" | "warning" | "info";

export interface LintIssue {
  nodeId: string;
  /** The key on the node the issue is about, when it's about one. */
  key?: string;
  severity: LintSeverity;
  message: string;
}

/** Verbs a request can actually be sent with. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** `bearer …`, `none`, or a literal header value — anything else is suspicious. */
const KNOWN_AUTH = /^(none|bearer\s+.+|basic\s+.+)$/i;

// Deliberately NOT flagged: `expect: 200` on a node that also draws `-404>`.
// That pairing is the idiom, not a contradiction — `expect` asserts the happy
// path, the edges map every outcome — and the engine walks the drawn edge
// either way while still scoring the step red. See runFlow's `stopOnFailure`.

function isAbsolute(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Every semantic problem in one doc.
 *
 * Errors are things that cannot run. Warnings are things that will run but
 * probably not as intended. Info is a statement of fact the author should
 * know — chiefly "this is a run-time input", which is by design, not a fault.
 */
export function lintDoc(doc: FmlDoc): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (nodeId: string, severity: LintSeverity, message: string, key?: string): void => {
    issues.push({ nodeId, severity, message, ...(key ? { key } : {}) });
  };

  // Which names anything in this doc can supply.
  const declared = new Set(Object.keys(doc.vars));
  const captured = new Map<string, string>();
  for (const node of doc.nodes) {
    for (const key of Object.keys(node.data)) {
      if (key.startsWith("capture.")) captured.set(key.slice("capture.".length), node.id);
    }
  }

  const base = (doc.meta.base ?? "").trim();

  for (const node of doc.nodes) {
    const spec = nodeTypeSpec(node.type);

    // 1. Keys outside the standard — the typo catcher. Only meaningful for a
    //    type we actually have a standard for.
    if (spec) {
      const allowed = new Set([...spec.expects, ...spec.optional, "label"]);
      for (const key of Object.keys(node.data)) {
        if (allowed.has(key)) continue;
        const dot = key.indexOf(".");
        const prefix = dot > 0 ? key.slice(0, dot) : "";
        if ((EXEC_KEY_PREFIXES as readonly string[]).includes(prefix)) {
          if (key.slice(dot + 1).trim() === "") {
            add(node.id, "warning", `"${key}" has no name after the dot`, key);
          }
          continue;
        }
        add(
          node.id,
          "warning",
          `"${key}" isn't part of the ${node.type} standard — it draws, but nothing acts on it`,
          key,
        );
      }
    } else if (!isKnownType(node.type)) {
      add(node.id, "warning", `"${node.type}" is outside the standard vocabulary`);
    }

    // 2. Variables referenced here that nothing in the doc supplies.
    for (const [key, value] of Object.entries(node.data)) {
      for (const name of varsInValue(value)) {
        if (declared.has(name) || captured.has(name)) continue;
        add(
          node.id,
          "info",
          `{${name}} is a run-time input — supply it when you run, or give it an @vars default`,
          key,
        );
      }
    }

    if (node.type !== "api") continue;

    // 3. Everything below is about actually sending the request.
    const data = node.data;
    const method = (data.method ?? "").trim();
    if (method && !METHODS.includes(method.toUpperCase())) {
      add(node.id, "warning", `"${method}" isn't a standard HTTP method`, "method");
    }

    const url = data.url?.trim();
    const path = data.path?.trim();
    if (!url && !path) {
      // A bare `Login = api` is a legitimate sketch — the standard says a
      // sketch stays cheap to write. It only becomes a contradiction once the
      // node carries execution detail: you clearly meant to send this.
      const meansToSend = Object.keys(data).some(
        (k) => k === "body" || k === "expect" || k === "auth" || k.includes("."),
      );
      add(
        node.id,
        meansToSend ? "error" : "warning",
        meansToSend
          ? "this node carries request detail but has no path or url to send it to"
          : "an api node needs a path or a url before it can run",
        "path",
      );
    } else if (!url && path && !isAbsolute(path) && base === "" && !data.base?.trim()) {
      // A warning, not an error: plenty of docs are only ever drawings, and
      // the runner reports this precisely at the moment it actually matters.
      add(
        node.id,
        "warning",
        `"${path}" is relative but neither this node nor the doc has a "base" — it can't run until one exists`,
        "path",
      );
    }
    if (url && !isAbsolute(url) && !url.includes("{")) {
      add(node.id, "warning", `"url" should be absolute — did you mean "path"?`, "url");
    }

    const expect = data.expect?.trim();
    if (expect && !isStatusLabel(expect)) {
      add(
        node.id,
        "warning",
        `"expect: ${expect}" isn't a status pattern — use 200, "200,201", 2xx or 200-204`,
        "expect",
      );
    }

    const auth = data.auth?.trim();
    if (auth && !KNOWN_AUTH.test(auth)) {
      add(node.id, "info", `"auth: ${auth}" is sent as a literal Authorization header`, "auth");
    }

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("capture.") && value.trim() === "") {
        add(node.id, "warning", `${key} has no path — it will never capture anything`, key);
      }
    }

  }

  return issues;
}

/** Just the issues that stop a run outright. */
export function lintErrors(doc: FmlDoc): LintIssue[] {
  return lintDoc(doc).filter((i) => i.severity === "error");
}
