// The real page driver for Apply (#45), on `playwright-core` (see core-conventions, "Apply").
// Apply must leave the visible browser open for the Handover after the CLI call exits, so the
// browser is started as its own detached process with a fresh, temporary profile (no saved
// logins, cookies or history) and Playwright only connects to it over the DevTools port.
// `apply close` (or a failed fill) kills it and deletes the profile.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type BrowserInfo,
  type ControlKind,
  type PageControl,
  type PageDriver,
  PageError,
} from "./apply-driver.ts";
import { browserHeadless, playwrightEntry } from "./env.ts";
import { CoreError } from "./errors.ts";

// biome-ignore lint/suspicious/noExplicitAny: playwright-core is loaded on demand and has no types here
type Any = any;
// The controls scan runs inside the page, where `document` exists.
declare const document: Any;

const INSTALL =
  "Apply fills forms with Playwright, which a plugin install doesn't bring. In the Job Butler " +
  "folder run `npm install` (it installs the pinned playwright-core) and then " +
  "`npx playwright-core install chromium`. To use an existing copy, set JOB_BUTLER_PLAYWRIGHT " +
  "to its playwright-core entry file.";

async function loadChromium(): Promise<Any> {
  const entry = playwrightEntry();
  let mod: Any;
  try {
    mod = await import(entry === undefined ? "playwright-core" : pathToFileURL(entry).href);
  } catch (e) {
    throw new CoreError(
      "BROWSER_UNAVAILABLE",
      `Playwright isn't installed (${(e as Error).message}). ${INSTALL}`,
    );
  }
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (chromium === undefined) {
    throw new CoreError(
      "BROWSER_UNAVAILABLE",
      `playwright-core has no chromium export. ${INSTALL}`,
    );
  }
  return chromium;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill the browser Apply started and delete its temporary profile. Safe to call twice. */
export async function closeBrowser(info: BrowserInfo): Promise<void> {
  for (const target of [-info.pid, info.pid]) {
    try {
      process.kill(target, "SIGTERM");
    } catch {}
  }
  for (let i = 0; i < 50 && alive(info.pid); i++) await sleep(100);
  if (alive(info.pid)) {
    try {
      process.kill(-info.pid, "SIGKILL");
    } catch {}
  }
  await rm(info.profile_dir, { recursive: true, force: true });
}

const q = (name: string) => name.replace(/["\\]/g, "\\$&");
// The label of a radio choice, evaluated in the page.
const choice = (el: Any) => el.labels?.[0]?.textContent?.trim() ?? el.value;
const selector = (name: string) => `[name="${q(name)}"], [id="${q(name)}"]`;

async function launch(): Promise<{ info: BrowserInfo; browser: Any }> {
  const chromium = await loadChromium();
  const exe: string = chromium.executablePath();
  const profile = await mkdtemp(join(tmpdir(), "job-butler-browser-"));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(browserHeadless() ? ["--headless=new"] : []),
    "about:blank",
  ];
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(exe, args, { detached: true, stdio: "ignore" });
  } catch (e) {
    await rm(profile, { recursive: true, force: true });
    throw new CoreError(
      "BROWSER_UNAVAILABLE",
      `The browser couldn't start (${(e as Error).message}). ${INSTALL}`,
    );
  }
  child.on("error", () => {});
  child.unref();
  const pid = child.pid as number;
  let port = 0;
  for (let i = 0; i < 150 && port === 0; i++) {
    try {
      port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
    } catch {
      await sleep(100);
    }
  }
  const info: BrowserInfo = { pid, port, profile_dir: profile };
  if (port === 0) {
    await closeBrowser(info);
    throw new CoreError("BROWSER_UNAVAILABLE", `The browser didn't start. ${INSTALL}`);
  }
  try {
    return { info, browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`) };
  } catch (e) {
    await closeBrowser(info);
    throw new CoreError(
      "BROWSER_UNAVAILABLE",
      `Couldn't connect to the browser (${(e as Error).message}).`,
    );
  }
}

const KINDS: Record<string, ControlKind> = {
  text: "text",
  email: "text",
  tel: "text",
  url: "text",
  number: "text",
  search: "text",
  file: "file",
  checkbox: "checkbox",
  radio: "radio",
  submit: "submit",
  image: "submit",
};

export async function playwrightDriver(): Promise<PageDriver> {
  const { info, browser } = await launch();
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page: Any = context.pages()[0] ?? (await context.newPage());
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw new PageError(`The page reported an error: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  return {
    async open(url) {
      const res: Any = await wrap(() =>
        page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }),
      );
      if (res === null || res.status() >= 400) {
        throw new PageError(`The page answered HTTP ${res?.status() ?? "nothing"}.`);
      }
    },
    async controls() {
      const raw: Any[] = await wrap(() =>
        page.evaluate(() =>
          [...document.querySelectorAll("input, textarea, select, button")].flatMap(
            (el: Any, _i: number, all: Any[]) => {
              const type = String(
                el.getAttribute("type") ?? (el.tagName === "BUTTON" ? "submit" : "text"),
              ).toLowerCase();
              if (type === "hidden") return [];
              const choiceLabel = (r: Any) => r.labels?.[0]?.textContent?.trim() ?? r.value;
              if (type === "radio") {
                // One control per radio group: its options are the choices' labels.
                const group = all.filter((r: Any) => r.type === "radio" && r.name === el.name);
                if (group[0] !== el) return [];
                const legend = el.closest("fieldset")?.querySelector("legend")?.textContent?.trim();
                return [
                  {
                    name: el.name,
                    tag: "INPUT",
                    type,
                    label: legend || el.name,
                    required: group.some((r: Any) => r.required),
                    submits: false,
                    options: group.map(choiceLabel),
                  },
                ];
              }
              const label =
                el.labels?.[0]?.textContent?.trim() ??
                el.getAttribute("aria-label") ??
                el.textContent?.trim() ??
                "";
              const submits =
                el.form !== null &&
                (type === "submit" || type === "image") &&
                el.tagName !== "SELECT";
              return [
                {
                  name: el.name || el.id || "",
                  tag: el.tagName,
                  type,
                  label: label || el.name || el.id,
                  required: el.required === true,
                  submits,
                  options:
                    el.tagName === "SELECT" ? [...el.options].map((o: Any) => o.label) : undefined,
                },
              ];
            },
          ),
        ),
      );
      return raw
        .filter((c) => c.name !== "")
        .map(
          (c): PageControl => ({
            name: c.name,
            kind:
              c.tag === "TEXTAREA"
                ? "textarea"
                : c.tag === "SELECT"
                  ? "select"
                  : (KINDS[c.type] ?? "other"),
            label: c.label,
            required: c.required,
            submits: c.submits,
            ...(c.options ? { options: c.options } : {}),
          }),
        );
    },
    async set(control, value) {
      const loc = page.locator(selector(control.name)).first();
      await wrap(async () => {
        if (control.kind === "radio") {
          const radios = page.locator(`input[type="radio"][name="${q(control.name)}"]`);
          for (let i = 0; i < (await radios.count()); i++) {
            const r = radios.nth(i);
            if ((await r.evaluate(choice)) === value) return r.check({ timeout: 5000 });
          }
          throw new Error(`no choice "${value}" on ${control.name}`);
        }
        if (control.kind === "select") await loc.selectOption({ label: value }, { timeout: 5000 });
        else if (control.kind === "file") await loc.setInputFiles(value, { timeout: 5000 });
        else if (control.kind === "checkbox") await loc.check({ timeout: 5000 });
        else await loc.fill(value, { timeout: 5000 });
      });
    },
    async read(control) {
      const loc = page.locator(selector(control.name)).first();
      return wrap(async () => {
        if (control.kind === "radio") {
          const radios = page.locator(`input[type="radio"][name="${q(control.name)}"]`);
          for (let i = 0; i < (await radios.count()); i++) {
            const r = radios.nth(i);
            if (await r.isChecked()) return String(await r.evaluate(choice));
          }
          return "";
        }
        if (control.kind === "select") {
          return String(await loc.evaluate((el: Any) => el.selectedOptions[0]?.label ?? ""));
        }
        if (control.kind === "file") {
          return basename(String(await loc.evaluate((el: Any) => el.files?.[0]?.name ?? "")));
        }
        if (control.kind === "checkbox") return (await loc.isChecked()) ? "checked" : "";
        return String(await loc.inputValue());
      });
    },
    async detach() {
      // For a browser reached over CDP, close() only drops Playwright's connection.
      await browser.close().catch(() => {});
      return info;
    },
    async close() {
      await browser.close().catch(() => {});
      await closeBrowser(info);
    },
  };
}
