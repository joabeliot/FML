// FML — body assertions: `assert.<path>: <comparison>` on `api` nodes.
//
// `expect` scores the status. This scores what the response *said* — a 200
// with the wrong number in the body is a pass for `expect` and a fail here.
//
// Shape, mirroring `capture.<var>`:
//
//   assert.sources.length: >= 2          the suffix is the path to read
//   assert.rate: $.data.income_rate ~11900+-50
//                                        a value starting with `$` names its
//                                        own path; the suffix is then only a
//                                        label for messages (needed for `[0]`
//                                        and `$`, which a key can't contain)
//   assert.title: text(h1) == Welcome     so does a page read on a `ui` node —
//                                        text( count( value( visible( attr( —
//                                        a CSS selector can't be a key either
//
// Comparisons:
//
//   active  /  == active    exact — numerically when both sides are numbers
//   "  >= 2  "              double quotes force a literal string match
//   != x                    not equal (same coercion as exact)
//   >= <= > < N             numeric
//   ~N+-T  /  ~N+-T%        numeric, within an explicit tolerance — absolute
//                           or relative. A bare `~N` is rejected on purpose:
//                           a hidden default tolerance is the thing you forget
//                           about when a test goes red.
//   matches <regex>         the value matches a JS regular expression
//   exists  /  absent       the path resolves to something / to nothing
//
// Parsing is separate from evaluation so lint can reject a malformed
// assertion without a response, and the runner can evaluate after `{name}`s
// are substituted (an assert may compare against a value captured moments
// earlier on the same node).
//
// Zero dependencies, like the rest of `src/fml/`.

export type AssertOp = "eq" | "ne" | "ge" | "le" | "gt" | "lt" | "approx" | "matches" | "exists" | "absent";

export interface Assertion {
  /** The key suffix — always shown in messages. */
  label: string;
  /** What to read from the response, in `readPath` syntax. */
  path: string;
  op: AssertOp;
  /** The right-hand side, raw (may still hold `{name}`s). Empty for exists/absent. */
  operand: string;
  /** The text after the colon, as written. */
  source: string;
}

export type ParsedAssertion = { ok: true; assertion: Assertion } | { ok: false; error: string };

const NUMERIC_OPS: Array<[string, AssertOp]> = [
  [">=", "ge"],
  ["<=", "le"],
  ["!=", "ne"],
  ["==", "eq"],
  [">", "gt"],
  ["<", "lt"],
];

const TOLERANCE_RE = /^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(?:\+-|±)\s*(\d*\.?\d+(?:e[-+]?\d+)?)(%?)$/i;

function isNumber(text: string): boolean {
  return text.trim() !== "" && Number.isFinite(Number(text));
}

/**
 * Parse one `assert.<label>: <value>` pair. Fails only on things that can
 * never evaluate — a numeric operator with a non-number, a `~` with no
 * tolerance, a bad regex. Operands holding `{name}` skip the number checks:
 * what they become is only known at run time.
 */
export function parseAssertion(label: string, value: string): ParsedAssertion {
  const source = value.trim();
  if (label.trim() === "") return { ok: false, error: "has no path after the dot" };

  let path = label;
  let rest = source;
  const call = pageReadEnd(rest);
  if (call !== undefined) {
    path = rest.slice(0, call);
    rest = rest.slice(call).trim();
    if (rest === "") return { ok: false, error: `names a path ("${path}") but nothing to compare it with` };
  } else if (rest.startsWith("$")) {
    const space = rest.search(/\s/);
    if (space === -1) return { ok: false, error: `names a path ("${rest}") but nothing to compare it with` };
    path = rest.slice(0, space);
    rest = rest.slice(space).trim();
  }
  if (rest === "") return { ok: false, error: "has nothing to compare against" };

  const make = (op: AssertOp, operand: string): ParsedAssertion => ({
    ok: true,
    assertion: { label, path, op, operand, source },
  });
  const deferred = (text: string): boolean => text.includes("{");

  if (rest === "exists") return make("exists", "");
  if (rest === "absent") return make("absent", "");

  if (rest.startsWith("matches ") || rest === "matches") {
    const pattern = rest.slice("matches".length).trim();
    if (pattern === "") return { ok: false, error: "`matches` needs a pattern" };
    if (!deferred(pattern)) {
      try {
        new RegExp(pattern);
      } catch (err) {
        return { ok: false, error: `bad pattern — ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return make("matches", pattern);
  }

  if (rest.startsWith("~")) {
    const spec = rest.slice(1).trim();
    if (!deferred(spec)) {
      if (isNumber(spec)) {
        return { ok: false, error: `"~${spec}" needs a tolerance — write ~${spec}+-<amount> or ~${spec}+-<n>%` };
      }
      if (!TOLERANCE_RE.test(spec)) {
        return { ok: false, error: `"~${spec}" isn't a tolerance — write ~N+-T or ~N+-T%` };
      }
    }
    return make("approx", spec);
  }

  for (const [symbol, op] of NUMERIC_OPS) {
    if (!rest.startsWith(symbol)) continue;
    const operand = rest.slice(symbol.length).trim();
    if (operand === "") return { ok: false, error: `"${symbol}" has nothing after it` };
    // == and != compare like a bare value; the ordering operators need numbers.
    if (op !== "eq" && op !== "ne" && !deferred(operand) && !isNumber(operand)) {
      return { ok: false, error: `"${symbol} ${operand}" needs a number` };
    }
    return make(op, operand);
  }

  return make("eq", rest);
}

/** Page reads a `ui` node's assert/capture can name — see run.ts `UiDriver.read`. */
export const PAGE_READS = ["text", "count", "value", "visible", "attr"] as const;

/**
 * If `text` starts with a page read like `text([data-x="a(b)"])`, the index
 * just past its closing paren — matched with nesting and quotes, since a CSS
 * selector can hold both. Undefined when it doesn't start with one.
 */
export function pageReadEnd(text: string): number | undefined {
  return callEnd(text, PAGE_READS);
}

/**
 * If `text` starts with `name(…)` for one of `names`, the index just past the
 * matching close paren — nesting and quotes respected, since a CSS selector
 * can hold both. Shared by page reads and ui's `sel(…)`.
 */
export function callEnd(text: string, names: readonly string[]): number | undefined {
  const m = text.match(/^([a-z]+)\(/);
  if (!m || !names.includes(m[1]!)) return undefined;
  let depth = 0;
  let quote: string | null = null;
  for (let i = m[1]!.length; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return undefined;
}

/** Strip one pair of surrounding double quotes — the escape for a literal string. */
function unquote(text: string): { text: string; quoted: boolean } {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return { text: text.slice(1, -1), quoted: true };
  }
  return { text, quoted: false };
}

function equalish(actual: string, expected: string): boolean {
  const { text, quoted } = unquote(expected);
  if (!quoted && isNumber(actual) && isNumber(text)) return Number(actual) === Number(text);
  return actual === text;
}

export interface AssertOutcome {
  ok: boolean;
  /** Why it failed, phrased to follow `assert.<label>`. */
  message?: string;
}

/**
 * Evaluate a parsed assertion against the value `readPath` returned (undefined
 * when the path led nowhere) and an operand that's already interpolated.
 */
export function evaluateAssertion(a: Assertion, actual: string | undefined, operand: string): AssertOutcome {
  if (a.op === "absent") {
    return actual === undefined ? { ok: true } : { ok: false, message: `expected nothing at "${a.path}", got ${actual}` };
  }
  if (actual === undefined) return { ok: false, message: `found nothing at "${a.path}"` };
  if (a.op === "exists") return { ok: true };

  const fail = (want: string): AssertOutcome => ({ ok: false, message: `expected ${want}, got ${actual}` });

  switch (a.op) {
    case "eq":
      return equalish(actual, operand) ? { ok: true } : fail(unquote(operand).text);
    case "ne":
      return !equalish(actual, operand) ? { ok: true } : fail(`anything but ${unquote(operand).text}`);
    case "matches": {
      let re: RegExp;
      try {
        re = new RegExp(operand);
      } catch (err) {
        return { ok: false, message: `bad pattern — ${err instanceof Error ? err.message : String(err)}` };
      }
      return re.test(actual) ? { ok: true } : fail(`a match for /${operand}/`);
    }
    case "approx": {
      const m = operand.trim().match(TOLERANCE_RE);
      if (!m) return { ok: false, message: `"~${operand}" isn't a tolerance — write ~N+-T or ~N+-T%` };
      if (!isNumber(actual)) return fail(`a number near ${m[1]}`);
      const target = Number(m[1]);
      const spread = m[3] === "%" ? Math.abs(target) * (Number(m[2]) / 100) : Number(m[2]);
      const want = `${m[1]} ± ${m[2]}${m[3]}`;
      return Math.abs(Number(actual) - target) <= spread ? { ok: true } : fail(want);
    }
    default: {
      if (!isNumber(operand)) return { ok: false, message: `"${operand}" isn't a number` };
      if (!isNumber(actual)) return fail(`a number ${symbolOf(a.op)} ${operand}`);
      const x = Number(actual);
      const y = Number(operand);
      const pass =
        a.op === "ge" ? x >= y : a.op === "le" ? x <= y : a.op === "gt" ? x > y : x < y;
      return pass ? { ok: true } : fail(`${symbolOf(a.op)} ${operand}`);
    }
  }
}

function symbolOf(op: AssertOp): string {
  return NUMERIC_OPS.find(([, o]) => o === op)?.[0] ?? op;
}
