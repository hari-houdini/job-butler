// The page-driver seam for Apply's browser fill (#45). The fill logic (apply-fill.ts) only
// sees a PageDriver, so it is tested with a scripted page (the fake driver here) and runs for
// real on Playwright (apply-playwright.ts). A driver has no click: the fill can't submit.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { browserDriver, fakePageFile } from "./env.ts";
import { CoreError } from "./errors.ts";

export type ControlKind = "text" | "textarea" | "select" | "file" | "checkbox" | "submit" | "other";

export interface PageControl {
  name: string;
  kind: ControlKind;
  label: string;
  required: boolean;
  /** True for any control that would submit the form (submit button or input, image input). */
  submits: boolean;
  options?: string[];
}

/** The page errored or can't be used. The fill pauses the Application. */
export class PageError extends Error {}

export interface BrowserInfo {
  pid: number;
  port: number;
  profile_dir: string;
}

export interface PageDriver {
  open(url: string): Promise<void>;
  controls(): Promise<PageControl[]>;
  /** Enter a value; for a file control `value` is the file's path. */
  set(control: PageControl, value: string): Promise<void>;
  /** What the control holds now: its text, the chosen option's label, or an upload's name. */
  read(control: PageControl): Promise<string>;
  /** Let go of the page but leave the visible browser open for the Handover. */
  detach(): Promise<BrowserInfo | null>;
  /** Close the browser and delete its ephemeral profile. */
  close(): Promise<void>;
}

interface FakePage {
  controls: PageControl[];
  /** What a control reads back as, when it differs from what was set. */
  readback?: Record<string, string>;
  /** The nth set (after this many) throws `error`. */
  fail_after?: number;
  error?: string;
  open_error?: string;
}

async function fakeDriver(): Promise<PageDriver> {
  const file = fakePageFile();
  if (file === undefined) {
    throw new CoreError(
      "BROWSER_UNAVAILABLE",
      "JOB_BUTLER_BROWSER=fake needs JOB_BUTLER_FAKE_PAGE.",
    );
  }
  const page = JSON.parse(await readFile(file, "utf8")) as FakePage;
  const values = new Map<string, string>();
  let sets = 0;
  return {
    async open() {
      if (page.open_error !== undefined) throw new PageError(page.open_error);
    },
    async controls() {
      return page.controls;
    },
    async set(control, value) {
      if (page.fail_after !== undefined && sets >= page.fail_after) {
        throw new PageError(page.error ?? "The page reported an error.");
      }
      sets++;
      values.set(control.name, control.kind === "file" ? basename(value) : value);
    },
    async read(control) {
      return page.readback?.[control.name] ?? values.get(control.name) ?? "";
    },
    async detach() {
      return null;
    },
    async close() {},
  };
}

export async function openDriver(): Promise<PageDriver> {
  if (browserDriver() === "fake") return fakeDriver();
  const { playwrightDriver } = await import("./apply-playwright.ts");
  return playwrightDriver();
}
