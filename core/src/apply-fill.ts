// Apply's browser fill and Handover (#45). `apply fill` opens the form in a visible browser,
// enters every Fill plan value, reads each field back and compares. It never clicks: the
// page driver has no click, and any control that would submit pauses the Application.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Status } from "./application.ts";
import { type Blocker, type FillPlan, type PlanField, saveApplication } from "./apply.ts";
import { openDriver, type PageControl, PageError } from "./apply-driver.ts";
import { timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { getRecord, notFound, type StoredRecord, withWriter } from "./store.ts";
import { voiceViolations } from "./voice.ts";

const STARTABLE: Status[] = ["ready_to_apply", "paused"];

const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();

interface Pause {
  code: "PAGE_ERROR" | "PAGE_CHANGED" | "SUBMIT_REFUSED";
  reason: string;
}

async function load(dataDir: string, id: string | undefined): Promise<StoredRecord> {
  if (id === undefined) throw usageError("<application-id> is required");
  const app = await getRecord(dataDir, "application", id);
  if (app === undefined) throw notFound("application", id);
  return app;
}

function planOf(app: StoredRecord): FillPlan {
  const plan = app.fill_plan as FillPlan | null;
  if (plan === null) {
    throw new CoreError(
      "NO_FILL_PLAN",
      `${app.company} · ${app.title} has no Fill plan yet. Run \`apply prepare\`, dispatch the apply worker, then \`apply plan\`.`,
    );
  }
  return plan;
}

/** Check every planned field has a safe control on the page; returns a pause if not. */
function preflight(plan: PlanField[], controls: PageControl[]): Pause | undefined {
  for (const f of plan) {
    const c = controls.find((x) => x.name === f.name);
    if (c === undefined) {
      return {
        code: "PAGE_CHANGED",
        reason: `The form no longer has the field "${f.name}" (${f.label}), so the page has changed since Apply read it.`,
      };
    }
    if (c.submits || c.kind === "submit") {
      return {
        code: "SUBMIT_REFUSED",
        reason: `The control "${f.name}" (${f.label}) would submit the form. Apply never clicks or fills a control that submits.`,
      };
    }
  }
  return undefined;
}

export async function applyFill(dataDir: string, id: string | undefined) {
  const app = await load(dataDir, id);
  const plan = planOf(app);
  if (!STARTABLE.includes(app.status as Status)) {
    throw new CoreError(
      "NOT_FILLABLE",
      `${app.company} · ${app.title} is ${String(app.status)}, so Apply can't fill its form now.`,
      { application_id: app.id },
    );
  }
  if (plan.unmappable.length > 0) {
    throw new CoreError(
      "PLAN_INCOMPLETE",
      `The Fill plan still has ${plan.unmappable.length} field(s) Apply couldn't map (${plan.unmappable.map((u) => u.name).join(", ")}). Ask the job seeker, store each answer with \`apply answer\`, then fill.`,
      { application_id: app.id },
    );
  }
  if (plan.browser !== null) {
    await (await import("./apply-playwright.ts")).closeBrowser(plan.browser);
  }

  const driver = await openDriver();
  let pause: Pause | undefined;
  const blockers: Blocker[] = [];
  const read = new Map<string, string>();
  let keepOpen = false;
  try {
    try {
      await driver.open(plan.form.url);
      const controls = await driver.controls();
      pause = preflight(plan.fields, controls);
      if (pause === undefined) {
        for (const f of plan.fields) {
          const c = controls.find((x) => x.name === f.name) as PageControl;
          await driver.set(c, f.type === "file" ? join(dataDir, f.path ?? f.value) : f.value);
        }
        for (const f of plan.fields) {
          const c = controls.find((x) => x.name === f.name) as PageControl;
          read.set(f.name, await driver.read(c));
        }
        const planned = new Set(plan.fields.map((f) => f.name));
        for (const c of controls) {
          if (planned.has(c.name) || c.submits || c.kind === "submit" || !c.required) continue;
          if (norm(await driver.read(c)) === "") {
            blockers.push({
              kind: "empty_required",
              field: c.name,
              detail: `"${c.label}" is required on the form and the plan leaves it empty.`,
            });
          }
        }
      }
    } catch (e) {
      if (!(e instanceof PageError)) throw e;
      pause = { code: "PAGE_ERROR", reason: e.message };
    }
    let info = null;
    if (pause === undefined) {
      keepOpen = true;
      info = await driver.detach();
    }

    const at = timestamp();
    const fields: PlanField[] = plan.fields.map((f) => {
      if (pause !== undefined) return { ...f, readback: null };
      const actual = read.get(f.name) ?? "";
      const want = f.type === "file" ? (f.value.split("/").pop() as string) : f.value;
      const match = norm(actual) === norm(want);
      if (!match) {
        blockers.unshift({
          kind: norm(actual) === "" && f.required ? "empty_required" : "mismatch",
          field: f.name,
          detail:
            norm(actual) === ""
              ? `"${f.label}" is empty after filling.`
              : `"${f.label}" holds "${actual}" but the plan says "${want}".`,
        });
      }
      return { ...f, readback: { value: actual, match, checked_at: at } };
    });
    if (pause === undefined) {
      for (const f of fields) {
        if (f.source.kind !== "written") continue;
        for (const rule of voiceViolations(f.value)) {
          blockers.push({
            kind: "voice",
            field: f.name,
            detail: `The answer to "${f.label}" uses ${rule}, which breaks the voice rules.`,
          });
        }
      }
    }
    const outcome = pause !== undefined ? "paused" : blockers.length > 0 ? "blocked" : "filled";
    const next: FillPlan = {
      ...plan,
      fields,
      blockers: pause !== undefined ? [] : blockers,
      state: outcome,
      readback_at: pause === undefined ? at : null,
      browser: info,
    };
    const to: Status = outcome === "paused" ? "paused" : "ready_to_apply";
    const reason =
      pause?.reason ??
      (outcome === "filled"
        ? "Form filled and read back; every field matches the Fill plan."
        : `Form filled but ${blockers.length} problem(s) block the Handover: ${blockers.map((b) => b.field).join(", ")}.`);
    await withWriter(dataDir, "apply fill", async (w) => {
      const fresh = (await getRecord(dataDir, "application", app.id)) as StoredRecord;
      await saveApplication(
        dataDir,
        w,
        fresh,
        {
          fill_plan: next,
          pause: pause === undefined ? null : { code: pause.code, reason: pause.reason, at },
        },
        { to, reason },
      );
    });
    return {
      application_id: app.id,
      outcome,
      status: to,
      ...(pause ? { code: pause.code, reason: pause.reason } : {}),
      blockers: next.blockers,
      fields: fields.length,
      browser_open: keepOpen && info !== null,
    };
  } finally {
    if (!keepOpen) await driver.close();
  }
}

/** Close the browser Apply left open for an Application and delete its ephemeral profile. */
export async function applyClose(dataDir: string, id: string | undefined) {
  const app = await load(dataDir, id);
  const plan = app.fill_plan as FillPlan | null;
  if (plan?.browser == null) return { application_id: app.id, closed: false };
  const info = plan.browser;
  await (await import("./apply-playwright.ts")).closeBrowser(info);
  await withWriter(dataDir, "apply close", async (w) => {
    await saveApplication(dataDir, w, app, { fill_plan: { ...plan, browser: null } });
  });
  return { application_id: app.id, closed: true };
}

export async function applyHandover(dataDir: string, id: string | undefined) {
  const app = await load(dataDir, id);
  const plan = planOf(app);
  if (plan.state === "blocked") {
    throw new CoreError(
      "HANDOVER_BLOCKED",
      `The Handover is blocked: ${plan.blockers.map((b) => b.detail).join(" ")} Fix the plan or the form, then run \`apply fill\` again.`,
      { application_id: app.id, blockers: plan.blockers },
    );
  }
  if (plan.state !== "filled" || app.status !== "ready_to_apply") {
    if (app.status === "handover" && plan.state === "filled") {
      // Showing the Handover again is fine.
    } else {
      throw new CoreError(
        "HANDOVER_BLOCKED",
        `${app.company} · ${app.title} isn't filled and read back yet (Fill plan ${plan.state}, Status ${String(app.status)}), so there is nothing to hand over.`,
        { application_id: app.id },
      );
    }
  }
  const fields = plan.fields.map((f) => ({
    name: f.name,
    label: f.label,
    value: f.value,
    readback: f.readback?.value ?? "",
    match: f.readback?.match === true,
  }));
  const files = await Promise.all(
    plan.fields
      .filter((f) => f.type === "file")
      .map(async (f) => ({
        name: f.value,
        path: f.path as string,
        bytes: (await stat(join(dataDir, f.path as string))).size,
      })),
  );
  if (app.status !== "handover") {
    await withWriter(dataDir, "apply handover", async (w) => {
      await saveApplication(
        dataDir,
        w,
        app,
        {},
        {
          to: "handover",
          reason:
            "Form filled and read back clean; handed over to the job seeker to review and click Submit.",
        },
      );
    });
  }
  const text = [
    `Handover: ${app.company} · ${app.title}`,
    ...fields.map((f) => `  ${f.label}: ${f.value}`),
    "Files attached:",
    ...files.map((f) => `  ${f.name} (${f.bytes} bytes)`),
  ].join("\n");
  return {
    application_id: app.id,
    status: "handover",
    form_url: plan.form.url,
    fields,
    files,
    text,
  };
}
