// The CLI's UiDriver (FML-19): Playwright behind src/fml/run.ts's interface.
//
// The engine never imports a browser — this is handed to runFlow the same way
// the fetch transport is. Lives in scripts/, never src/fml/, so the language
// stays dependency-free.
//
// Browser: Playwright's own Chromium if it's installed (`npx playwright
// install chromium`), otherwise the machine's Google Chrome — so a laptop
// with Chrome needs no extra download. FML_UI_BROWSER=chrome|chromium forces
// one.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { UiAction, UiDriver } from "../src/fml/run.ts";

export interface PlaywrightDriver extends UiDriver {
  close(): Promise<void>;
}

const STEP_TIMEOUT_MS = 15_000;

async function launch(headed: boolean): Promise<Browser> {
  const forced = process.env.FML_UI_BROWSER;
  const attempts = forced === "chrome" ? [{ channel: "chrome" }] : forced === "chromium" ? [{}] : [{}, { channel: "chrome" }];
  let last: unknown;
  for (const opts of attempts) {
    try {
      return await chromium.launch({ headless: !headed, ...opts });
    } catch (err) {
      last = err;
    }
  }
  throw new Error(
    `no browser to drive — install one with \`npx playwright install chromium\`, or install Google Chrome (${last instanceof Error ? last.message.split("\n")[0] : String(last)})`,
  );
}

/** `attr(sel, name)` → ["sel", "name"]; the last comma splits, so selectors may hold commas. */
function attrArgs(inner: string): [string, string] {
  const i = inner.lastIndexOf(",");
  return i === -1 ? [inner.trim(), ""] : [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
}

export async function createPlaywrightDriver(opts: { headed: boolean; artifacts: string }): Promise<PlaywrightDriver> {
  const browser = await launch(opts.headed);
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const dir = resolve(opts.artifacts);

  return {
    async perform(action: UiAction): Promise<void> {
      switch (action.kind) {
        case "open":
          await page.goto(action.target, { waitUntil: "load" });
          return;
        case "fill":
          await page.locator(action.target).first().fill(action.value ?? "");
          return;
        case "click":
          await page.locator(action.target).first().click();
          return;
        case "press":
          if (action.target) await page.locator(action.target).first().press(action.value ?? "Enter");
          else await page.keyboard.press(action.value ?? "Enter");
          return;
        case "wait":
          await page.locator(action.target).first().waitFor({ state: "visible" });
          return;
      }
    },

    async read(path: string): Promise<string | undefined> {
      const p = path.trim();
      if (p === "url") return page.url();
      if (p === "title") return page.title();
      const m = p.match(/^(text|count|value|visible|attr)\((.*)\)$/s);
      if (!m) return undefined;
      const [, fn, inner] = m as unknown as [string, string, string];
      if (fn === "count") return String(await page.locator(inner).count());
      if (fn === "visible") return String(await page.locator(inner).first().isVisible());
      const el = page.locator(fn === "attr" ? attrArgs(inner)[0] : inner).first();
      if ((await el.count()) === 0) return undefined;
      if (fn === "text") return (await el.innerText()).trim();
      if (fn === "value") return el.inputValue();
      const v = await el.getAttribute(attrArgs(inner)[1]);
      return v ?? undefined;
    },

    async screenshot(name: string): Promise<string> {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.png`);
      await page.screenshot({ path: file, fullPage: true });
      return file;
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };
}
