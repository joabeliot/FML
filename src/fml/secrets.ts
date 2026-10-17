// FML — run-time secrets from a file.
//
// Tokens (`appCheck`, `memberToken`, a password) are run-time inputs by
// design: they never live in the `.fml`. Passing them as `--var` each run
// puts them in shell history; this is the alternative — a gitignored
// `.fml.env` beside the flow, in the familiar dotenv shape:
//
//   # comments and blank lines are fine
//   memberToken=eyJhbGciOi…
//   export appCheck="abc 123"      # `export` and quotes are optional
//
// Everything loaded from here is a secret, whatever it's called: the runner
// redacts each value from all output by value (see report.ts).
//
// Pure text in, values out — reading the file is the caller's job, so this
// stays dependency-free and testable.

export interface SecretsFileIssue {
  line: number;
  message: string;
}

export interface ParsedSecrets {
  values: Record<string, string>;
  issues: SecretsFileIssue[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseSecretsFile(text: string): ParsedSecrets {
  const values: Record<string, string> = {};
  const issues: SecretsFileIssue[] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) {
      issues.push({ line: i + 1, message: `expected name=value` });
      return;
    }
    const name = body.slice(0, eq).trim();
    if (!NAME_RE.test(name)) {
      issues.push({ line: i + 1, message: `"${name}" isn't a variable name — letters, digits and _ only` });
      return;
    }
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      // Quoted: taken literally, `#` and all.
      value = value.slice(1, -1);
    } else {
      // Unquoted: a ` #` starts a trailing comment, as in most dotenv readers.
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    values[name] = value;
  });

  return { values, issues };
}
