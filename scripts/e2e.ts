// Usage: npm run test:e2e        (add --headed to watch)
//
// End-to-end regression suite for the dashboard and the browser-driving
// CLI. It starts its own Vite dev server and a local fixture API
// (scripts/testkit), drives the real app in Chrome with Playwright, and
// checks the *file text* after every edit — the .fml is the product, the
// canvas is a view of it. No internet needed.
//
// Each scenario gets a fresh browser context (clean localStorage) and fails
// on any console error or React Flow warning it causes.
//
// Covers: loading + portals (pre-existing), source editing, property
// write-back, structural editing (FML-22), data wires (FML-20), the roadmap
// view (FML-21), the in-app runner incl. skipped ui steps, and ui steps
// driving a real browser from the CLI (FML-19).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { PASSWORD, startFixture, type Fixture } from "./testkit/fixtureServer.ts";
import { launch } from "./uiDriver.ts";

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

const WS_KEY = "protoarque_fml_ws";
const headed = process.argv.includes("--headed");

let vite: ViteDevServer | undefined;
let browser: Browser | undefined;
let fx: Fixture | undefined;
let appUrl = "";

/** Console messages that mean something broke. The attribution notice is intentional. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("hiding the attribution")) return;
    // Judged by URL below instead — the console line doesn't say which resource.
    if (t.startsWith("Failed to load resource")) return;
    if (m.type() === "error" || (m.type() === "warning" && t.includes("React Flow"))) problems.push(t.slice(0, 200));
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    // The app ships no favicon; the browser asking for one isn't a fault.
    if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
  return problems;
}

/** A fresh context with the given workspace (or the built-in sample when omitted). */
async function open(files?: Record<string, string>, entry?: string): Promise<{ page: Page; problems: string[] }> {
  const context = await browser!.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const problems = watchConsole(page);
  if (files) {
    await page.addInitScript(
      ([key, ws]) => {
        if (!sessionStorage.getItem("seeded")) {
          localStorage.setItem(key, ws);
          sessionStorage.setItem("seeded", "1");
        }
      },
      [WS_KEY, JSON.stringify({ files, entry: entry ?? Object.keys(files)[0] })] as const,
    );
  }
  await page.goto(appUrl);
  await page.locator(".react-flow__node").first().waitFor();
  return { page, problems };
}

const fileText = (page: Page, key: string) =>
  page.evaluate(([k, f]) => (JSON.parse(localStorage.getItem(k) ?? "{}") as { files: Record<string, string> }).files[f] ?? "", [WS_KEY, key] as const);

const center = async (page: Page, selector: string) => {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/**
 * Wait until the camera has stopped moving — an add/rename refits the view
 * with a short animation, and a drag that starts mid-animation lands
 * somewhere else.
 */
async function stillCamera(page: Page): Promise<void> {
  let last = "";
  for (let i = 0; i < 40; i++) {
    const now = await page.locator(".react-flow__viewport").getAttribute("style");
    if (now === last) return;
    last = now ?? "";
    await page.waitForTimeout(120);
  }
}

/** A real mouse drag — React Flow's connect gesture. */
async function drag(page: Page, from: string, to: string): Promise<void> {
  await stillCamera(page);
  const a = await center(page, from);
  const b = await center(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

const node = (id: string) => `.react-flow__node[data-id="${id}"]`;
const handle = (id: string, h: string) => `${node(id)} .react-flow__handle[data-handleid="${h}"]`;
const button = (page: Page, text: string | RegExp) => page.getByRole("button", { name: text }).first();
const settle = (page: Page) => page.waitForTimeout(350);

async function scenario(name: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n# ${name}`);
  try {
    await body();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Playwright puts the locator it was waiting on a few lines down.
    const where = msg.split("\n").find((l) => l.includes("locator(") || l.includes("waiting for"))?.trim() ?? "";
    ok(`${name} ran to completion`, false, `${msg.split("\n")[0]} ${where}`);
  }
}

// -- fixtures --------------------------------------------------------------

const EDIT_FLOW = `@nodes
  Login = page
  auth  = api
  Home  = page

@node auth {
  method: POST
  path: /login
}

@flow
  Login -tap> auth   # tapping
  auth:
    -200> Home
`;

const DATA_FLOW = `@meta
  base: https://api.test

@nodes
  login  = api
  getMe  = api
  income = api

@node login {
  method: POST
  path: /login
  capture.token: $.token
  capture.userId: $.id
}

@node getMe {
  path: /users/{userId}
  header.X-Trace: {token}
}

@node income {
  path: /income
}

@flow
  login -200> getMe
  getMe -200> income
`;

const VAR_FLOW = `@vars
  email: a@b.c

@nodes
  login  = api
  verify = api

@node login {
  method: POST
  path: /login
  body: {email}
}

@node verify {
  method: POST
  path: /verify
  body: {otp}
}

@flow
  login -200> verify
`;

const runFlow = (base: string) => `@meta
  base: ${base}

@nodes
  login   = api
  me      = api
  browse  = ui
  Home    = page

@node login {
  method: POST
  path: /login
  body: {"password":"{password}"}
  capture.token: $.token
  expect: 200
}

@node me {
  path: /me
  auth: bearer {token}
  expect: 200
  assert.name: Ada
}

@node browse {
  open: ${base}/form
}

@flow
  login -200> me
  me -200> browse
  browse -> Home
`;

// -- the run -----------------------------------------------------------------

try {
  const fixture = await startFixture();
  fx = fixture;
  vite = await createServer({ root: process.cwd(), logLevel: "error", server: { port: 5310, strictPort: false } });
  await vite.listen();
  appUrl = vite.resolvedUrls?.local[0] ?? "http://localhost:5310/";
  browser = await launch(headed);
  const api = fixture.url;

  await scenario("the sample loads, portals expand and drill in", async () => {
    const { page, problems } = await open();
    ok("the sample draws its nodes", (await page.locator(".react-flow__node").count()) >= 7);
    await page.locator('button[title^="Expand"]').first().click();
    await settle(page);
    ok("expanding a portal shows its doc inline", (await page.locator('.react-flow__node[data-id*="::"]').count()) > 0);
    await page.locator(node("Checkout")).dblclick();
    await page.locator(node("Cart")).waitFor();
    ok("double-clicking a portal opens its doc", await page.locator(node("Cart")).isVisible());
    ok("no console errors", problems.length === 0, problems.join(" | "));
  });

  await scenario("source editing and property write-back", async () => {
    const { page, problems } = await open({ t: EDIT_FLOW });
    await button(page, "Source").click();
    const ta = page.locator("textarea").first();
    await ta.fill(EDIT_FLOW.replace("  Home  = page", "  Home  = page\n  Extra = event"));
    await page.locator(node("Extra")).waitFor();
    ok("typing in Source re-draws the canvas", await page.locator(node("Extra")).isVisible());
    await button(page, "Source").click();

    await page.locator(node("auth")).click();
    await button(page, "+ note").click();
    const noteValue = page.locator("textarea, input").filter({ hasNot: page.locator('[title^="Letters"]') }).last();
    await noteValue.fill("signs the user in");
    await noteValue.blur();
    await settle(page);
    ok("a property panel edit is written into the @node block", (await fileText(page, "t")).includes("note: signs the user in"));
    ok("comments elsewhere survive", (await fileText(page, "t")).includes("# tapping"));
    ok("no console errors", problems.length === 0, problems.join(" | "));
  });

  await scenario("structural editing (FML-22)", async () => {
    const { page, problems } = await open({ t: EDIT_FLOW });
    await button(page, "+ Node").click();
    await page.getByRole("button", { name: /^Page/ }).first().click();
    await page.locator(node("page1")).waitFor();
    ok("+ Node declares a node", (await fileText(page, "t")).includes("page1 = page"));
    ok("…and selects it", (await page.locator('input[title^="Letters"]').inputValue()) === "page1");

    const id = page.locator('input[title^="Letters"]');
    await id.fill("Settings");
    await id.press("Enter");
    await page.locator(node("Settings")).waitFor();
    ok("renaming rewrites the declaration", (await fileText(page, "t")).includes("Settings = page"));
    await id.fill("Login");
    await id.press("Enter");
    await settle(page);
    ok("renaming onto a taken id is refused", (await page.getByText("that id is already used").count()) === 1);

    await drag(page, handle("Settings", "s-bottom"), node("Home"));
    await settle(page);
    ok("dragging handle → node draws an edge", (await fileText(page, "t")).includes("Settings -> Home"), await fileText(page, "t"));
    const label = page.locator('input[placeholder="(none)"]');
    await label.fill("open");
    await label.press("Enter");
    await settle(page);
    ok("the new edge is selected for its label", (await fileText(page, "t")).includes("Settings -open> Home"));

    await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
    await page.locator('[data-testid="rf__edge-edge_Settings_Home"] .react-flow__edge-interaction').click({ force: true });
    await page.keyboard.press("Delete");
    await settle(page);
    ok("Delete removes the selected edge", !(await fileText(page, "t")).includes("Settings -open> Home"));
    await page.keyboard.press("Control+z");
    await settle(page);
    ok("⌘Z / Ctrl+Z brings it back", (await fileText(page, "t")).includes("Settings -open> Home"));

    await drag(page, handle("Login", "s-bottom"), handle("Home", "t-top"));
    await settle(page);
    ok(
      "dropping exactly on a handle makes one edge, not two",
      ((await fileText(page, "t")).match(/Login -> Home/g) ?? []).length === 1,
      await fileText(page, "t"),
    );

    await page.locator(node("Settings")).click();
    await button(page, "Delete").click();
    await settle(page);
    const after = await fileText(page, "t");
    ok("deleting a node removes it and its edges", !after.includes("Settings"), after);
    ok("…without touching the rest", after.includes("Login -tap> auth   # tapping") && after.includes("-200> Home"));
    ok("no console errors", problems.length === 0, problems.join(" | "));
  });

  await scenario("data wires (FML-20)", async () => {
    const { page, problems } = await open({ t: DATA_FLOW });
    const dashed = () => page.locator('.react-flow__edge path[style*="dasharray"]').count();
    ok("with Data off and nothing selected, no wires", (await dashed()) === 0);
    await page.locator(node("getMe")).click();
    await settle(page);
    ok("selecting a node shows its wires", (await dashed()) === 2);
    await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
    await button(page, "Data").click();
    await settle(page);
    ok("the Data toggle shows every wire", (await dashed()) === 2);

    await drag(page, handle("login", "d-out-token"), node("income"));
    await page.getByText("auth: bearer {token}").waitFor();
    await page.getByText("auth: bearer {token}").click();
    await settle(page);
    ok("dropping a wire on a card writes the reference", (await fileText(page, "t")).includes("auth: bearer {token}"));
    ok("…and the new wire is drawn", (await dashed()) === 3);
    ok("no console errors", problems.length === 0, problems.join(" | "));
  });

  await scenario("variable nodes and always-on ports (FML-27)", async () => {
    const { page, problems } = await open({ t: VAR_FLOW });
    ok("input ports show with nothing selected", (await page.locator('.react-flow__handle[data-handleid^="d-in-"]').count()) === 2);
    ok("an @vars entry is a node", await page.locator(node("var:email")).isVisible());
    ok("so is a run-time input", await page.locator(node("var:otp")).isVisible());

    await button(page, "+ Node").click();
    await page.getByRole("button", { name: /Variable/ }).click();
    await page.locator(node("var:var1")).waitFor();
    ok("+ Node → Variable adds an @vars entry", /@vars\n\s+email: a@b\.c\n\s+var1:/.test(await fileText(page, "t")), await fileText(page, "t"));

    await page.locator("label").filter({ hasText: /^name/ }).locator("input").fill("code");
    await page.locator("label").filter({ hasText: /^name/ }).locator("input").press("Enter");
    await page.locator(node("var:code")).waitFor();
    await page.locator("label").filter({ hasText: /^value/ }).locator("input").fill("123456");
    await page.locator("label").filter({ hasText: /^value/ }).locator("input").press("Enter");
    await settle(page);
    ok("the panel renames it and sets its value", (await fileText(page, "t")).includes("code: 123456"), await fileText(page, "t"));

    await drag(page, handle("var:code", "d-out-code"), handle("verify", "d-in-otp"));
    await settle(page);
    const text = await fileText(page, "t");
    ok("dropping its port on an input port repoints that reference", text.includes("body: {code}") && !text.includes("{otp}"), text);

    await page.locator(node("var:email")).click();
    await button(page, "Delete").click();
    await settle(page);
    ok("deleting a variable removes its @vars entry", !(await fileText(page, "t")).includes("email: a@b.c"));
    ok("its reference stays, now asked at run", await page.locator(node("var:email")).isVisible());
    ok("no console errors", problems.length === 0, problems.join(" | "));
  });

  await scenario("roadmap view (FML-21)", async () => {
    const { page, problems } = await open({ t: EDIT_FLOW });
    await page.getByRole("button", { name: /^roadmap/i }).click();
    await button(page, "Load the example roadmap").click();
    await page.locator(node("parser")).waitFor();
    ok("the example roadmap draws", (await page.locator(".react-flow__node").count()) === 20);
    ok("the frontier is tagged NEXT", (await page.getByText("next", { exact: true }).count()) === 3);
    await page.locator(node("stagingGate")).click();
    await page.locator("select").last().selectOption("active");
    await settle(page);
    ok("changing a status writes it into the .rml", /@node stagingGate \{[^}]*status: active/.test(await fileText(page, "roadmap.rml")));
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: /^flows$/i }).click();
      await page.locator(node("Login")).waitFor();
      await page.getByRole("button", { name: /^roadmap/i }).click();
      await page.locator(node("parser")).waitFor();
    }
    ok("switching views back and forth is clean (no stray node types)", problems.length === 0, problems.join(" | "));
  });

  await scenario("in-app run against a local API, ui steps skipped", async () => {
    const { page, problems } = await open({ t: runFlow(api) });
    await button(page, "▶ Run").click();
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('input[type="password"]').press("Enter");
    await button(page, "▶ Run").waitFor({ timeout: 30_000 });
    await settle(page);
    const marks = await page.locator("span").filter({ hasText: /^[✔✖–]$/ }).allTextContents();
    ok("both api steps pass through the dev proxy", marks.filter((m) => m === "✔").length === 2, marks.join(""));
    ok("the ui step is skipped, not passed or failed", marks.includes("–") && !marks.includes("✖"), marks.join(""));
    ok("no console errors", problems.length === 0, problems.join(" | "));
  });

  await scenario("ui steps drive a real browser from the CLI (FML-19)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fml-e2e-"));
    try {
      const flow = join(dir, "ui.fml");
      const write = (assertion: string) =>
        writeFileSync(
          flow,
          `@meta\n  ui_base: ${api}\n\n@vars\n  who: Ada\n\n@nodes\n  fillIt = ui\n  sent = ui\n\n` +
            `@node fillIt {\n  open: /form\n  fill.custname: {who}\n  fill.email: sel(input[data-testid=email]) ada@x.io\n  screenshot: filled\n}\n\n` +
            `@node sent {\n  click: button\n  wait: [data-testid=thanks]\n  ${assertion}\n  capture.mail: text(p.email)\n}\n\n` +
            `@flow\n  fillIt -> sent\n`,
        );
      const cli = (args: string[]) =>
        new Promise<{ code: number; out: string }>((resolve) => {
          const child = spawn(process.execPath, ["scripts/run.ts", flow, "--artifacts", join(dir, "shots"), ...args], { cwd: process.cwd() });
          let out = "";
          child.stdout.on("data", (c) => (out += c));
          child.stderr.on("data", (c) => (out += c));
          child.on("close", (code) => resolve({ code: code ?? -1, out }));
        });

      write("assert.thanks: text([data-testid=thanks]) == Thanks, {who}");
      const pass = await cli([]);
      ok("a ui flow passes against a real page", pass.code === 0 && pass.out.includes("PASS"), pass.out);
      ok("fill.<field> by name and sel(…) both landed", pass.out.includes("capture mail = ada@x.io"), pass.out);
      ok("the screenshot was saved", existsSync(join(dir, "shots", "filled.png")));

      write("assert.thanks: text([data-testid=thanks]) == Thanks, Bob");
      const wrong = await cli(["--json"]);
      ok("a wrong page assert fails the run", wrong.code === 1 && wrong.out.includes('"kind": "assert"'), wrong.out.slice(0, 400));

      writeFileSync(flow, `@meta\n  ui_base: ${api}\n@nodes\n  a = ui\n@node a {\n  open: /form\n  click: [data-testid=missing]\n}\n`);
      const missing = await cli([]);
      ok("a missing element fails the step and names the action", missing.code === 1 && missing.out.includes("click [data-testid=missing] failed"), missing.out.slice(0, 400));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
} catch (err) {
  ok("the e2e harness started", false, err instanceof Error ? err.message : String(err));
} finally {
  await browser?.close();
  await vite?.close();
  await fx?.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
