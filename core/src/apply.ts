// Apply (#45): fill a Greenhouse application form from a Fill plan, read every field back
// and hand over to the job seeker, who clicks Submit themselves. The core never clicks
// Submit and records Submitted only under a Handover Approval.
//   apply prepare   read each form, hand the worker its material; a missing posting pauses
//   apply plan      check the worker's Fill plan, store it (an unmappable field pauses)
//   apply answer    the job seeker's answer to one unmappable field, kept on the Application
//   apply fill      (apply-fill.ts) fill the form in a browser and read it back
//   apply handover  show every field and file; Handover Status only when the read-back is clean
// Shapes and rules: docs/agents/core-conventions.md, "Apply: Greenhouse fill, read-back and Handover".
import { join } from "node:path";
import { type EventLogEntry, STATUSES, type Status, statusLabel } from "./application.ts";
import { approvalUsedFor, normaliseAction } from "./approval.ts";
import { type FormField, type FormSchema, readGreenhouseForm } from "./boards/greenhouse-form.ts";
import { writeTrees } from "./decision-tree.ts";
import { timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { assertProfileComplete, type Profile, readProfile } from "./profile.ts";
import {
  getRecord,
  listRecords,
  notFound,
  type StoredRecord,
  type StoreWriter,
  withWriter,
} from "./store.ts";
import { isObject } from "./validate.ts";

type Any = Record<string, unknown>;
const FILLABLE: Status[] = ["tailored", "ready_to_apply", "paused"];

export type SourceKind = "identity" | "answer_bank" | "tailor" | "written" | "application_answer";
const SOURCE_KINDS: SourceKind[] = [
  "identity",
  "answer_bank",
  "tailor",
  "written",
  "application_answer",
];

/** One field of the stored Fill plan. */
export interface PlanField {
  name: string;
  label: string;
  type: FormField["type"];
  required: boolean;
  value: string;
  source: { kind: SourceKind; ref?: string | number; basis?: string };
  /** The tailor file's path under the data directory, for an upload. */
  path?: string;
  readback: { value: string; match: boolean; checked_at: string } | null;
}

export interface FillPlan {
  state: "planned" | "paused" | "filled" | "blocked";
  built_at: string;
  form: { url: string; board_token: string; job_id: string; fetched_at: string };
  fields: PlanField[];
  unmappable: (Pick<FormField, "name" | "label" | "type" | "required" | "options"> & {
    reason: string;
  })[];
  blockers: Blocker[];
  readback_at: string | null;
  browser: { pid: number; port: number; profile_dir: string } | null;
}

export interface Blocker {
  kind: "mismatch" | "empty_required" | "voice";
  field: string;
  detail: string;
}

// ---------------------------------------------------------------------------------------
// Where the form is

interface Target {
  token: string;
  jobId: string;
  url: string;
}

const sourceOf = (a: { id: string; source?: string }) => a.source ?? a.id.split(":")[0] ?? "";

/** The employer-ATS (Greenhouse) copy of the Listing, or undefined when there is none. */
function greenhouseTarget(listing: StoredRecord): Target | undefined {
  const aliases = (listing.aliases as { id: string; url: string | null; source?: string }[]) ?? [];
  const mine = aliases.find(
    (a) => sourceOf(a) === "greenhouse" && typeof a.url === "string" && a.url !== "",
  );
  if (mine === undefined) return undefined;
  const [, token, jobId] = mine.id.split(":");
  if (token === undefined || jobId === undefined) return undefined;
  return { token, jobId, url: mine.url as string };
}

function linkOf(listing: StoredRecord): string | null {
  const aliases = (listing.aliases as { url: string | null }[]) ?? [];
  const url = aliases.find((a) => typeof a.url === "string")?.url ?? listing.url;
  return typeof url === "string" && url !== "" ? url : null;
}

// ---------------------------------------------------------------------------------------
// Event log

function entry(from: Status, to: Status, reason: string): EventLogEntry {
  return { at: timestamp(), stage: "apply", from, to, reason, approval: null };
}

/** Save the Application (and its Decision tree) with an optional Status change. */
export async function saveApplication(
  dataDir: string,
  w: StoreWriter,
  app: StoredRecord,
  changes: Record<string, unknown>,
  move?: { to: Status; reason: string },
): Promise<StoredRecord> {
  const log = [...(app.event_log as EventLogEntry[])];
  if (move !== undefined && move.to !== app.status) {
    log.push(entry(app.status as Status, move.to, move.reason));
  }
  const { id: _i, created_at: _c, updated_at: _u, schema_version: _s, ...fields } = app;
  const saved = await w.put("application", app.id, {
    ...fields,
    ...changes,
    status: move?.to ?? app.status,
    event_log: log,
  });
  const listing =
    typeof app.listing === "string" ? await getRecord(dataDir, "listing", app.listing) : undefined;
  if (listing !== undefined) await writeTrees(dataDir, [listing], [saved]);
  return saved;
}

function getApp(app: StoredRecord | undefined, id: string): StoredRecord {
  if (app === undefined) throw notFound("application", id);
  return app;
}

function pausedMessage(app: StoredRecord): string {
  return `${app.company} · ${app.title} is ${statusLabel(String(app.status))}`;
}

// ---------------------------------------------------------------------------------------
// apply prepare

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}
export function lastName(name: string): string {
  return name.trim().split(/\s+/).slice(1).join(" ");
}

function identityOf(profile: Profile): Record<string, string | null> {
  const id = (profile.identity ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const name = s(id.name);
  const out: Record<string, string | null> = {
    name,
    first_name: name === null ? null : firstName(name),
    last_name: name === null ? null : lastName(name),
    email: s(id.email),
    phone: s(id.phone),
    country: s(id.country),
    location: s(id.location),
  };
  for (const l of (id.links as { label: string; url: string }[]) ?? []) {
    out[`link:${l.label}`] = l.url;
  }
  return out;
}

function tailorFiles(app: StoredRecord): { kind: string; name: string; path: string }[] {
  const t = app.tailor as { folder?: string; files?: Record<string, string> } | null;
  if (t?.folder === undefined || t.files?.docx === undefined) return [];
  return [{ kind: "resume", name: t.files.docx, path: join(t.folder, t.files.docx) }];
}

export async function applyPrepare(dataDir: string, ids: string[]) {
  await assertProfileComplete(dataDir);
  const profile = (await readProfile(dataDir)) as Profile;
  const all = await listRecords(dataDir, "application");
  const chosen =
    ids.length > 0
      ? ids.map((id) =>
          getApp(
            all.find((a) => a.id === id),
            id,
          ),
        )
      : all.filter((a) => a.origin === "picked" && FILLABLE.includes(a.status as Status));
  const applications: Any[] = [];
  const byHand: Any[] = [];
  const paused: Any[] = [];
  const toPause: { app: StoredRecord; reason: string; code: string }[] = [];
  for (const app of chosen) {
    if (!FILLABLE.includes(app.status as Status)) {
      throw new CoreError(
        "NOT_FILLABLE",
        `${pausedMessage(app)}, so Apply can't fill its form now. Apply fills Applications that are Tailored, Ready to apply or Paused.`,
        { application_id: app.id },
      );
    }
    const listing =
      typeof app.listing === "string"
        ? await getRecord(dataDir, "listing", app.listing)
        : undefined;
    if (listing === undefined) throw notFound("listing", String(app.listing));
    const target = greenhouseTarget(listing);
    if (target === undefined) {
      byHand.push({
        application_id: app.id,
        company: app.company,
        title: app.title,
        link: linkOf(listing),
        message:
          "This job is only on LinkedIn, and Apply fills employer forms. Open the link and apply by hand.",
      });
      continue;
    }
    let form: FormSchema;
    try {
      form = await readGreenhouseForm(target.token, target.jobId, timestamp());
    } catch (e) {
      if (e instanceof CoreError && e.code === "POSTING_GONE") {
        toPause.push({
          app,
          code: e.code,
          reason: `The posting is no longer on Greenhouse, so Apply paused. Check the job is still open.`,
        });
        continue;
      }
      throw e;
    }
    applications.push({
      application_id: app.id,
      listing_id: listing.id,
      company: app.company,
      title: app.title,
      form: {
        url: target.url,
        board_token: target.token,
        job_id: target.jobId,
        fields: form.fields,
      },
      identity: identityOf(profile),
      answer_bank: (profile.answer_bank as unknown[]) ?? [],
      answers: app.answers ?? [],
      tailor_files: tailorFiles(app).map(({ kind, name }) => ({ kind, name })),
      previous_plan: app.fill_plan ?? null,
      judgments_file: join(dataDir, "inbox", `apply-${encodeURIComponent(app.id)}.json`),
    });
  }
  if (toPause.length > 0) {
    await withWriter(dataDir, "apply prepare", async (w) => {
      for (const p of toPause) {
        const plan = (p.app.fill_plan as FillPlan | null) ?? null;
        await saveApplication(
          dataDir,
          w,
          p.app,
          {
            pause: { code: p.code, reason: p.reason, at: timestamp() },
            fill_plan: plan === null ? null : { ...plan, state: "paused" },
          },
          { to: "paused", reason: p.reason },
        );
        paused.push({ application_id: p.app.id, code: p.code, reason: p.reason });
      }
    });
  }
  return { applications, by_hand: byHand, paused };
}

// ---------------------------------------------------------------------------------------
// apply plan

export async function loadForm(app: StoredRecord): Promise<FormSchema> {
  const plan = app.fill_plan as FillPlan | null;
  const target = plan?.form;
  if (target !== undefined) {
    return readGreenhouseForm(target.board_token, target.job_id, timestamp());
  }
  throw new CoreError("NO_FILL_PLAN", `${pausedMessage(app)} has no Fill plan yet.`);
}

function planProblems(
  j: unknown,
  form: FormSchema,
  identity: Record<string, string | null>,
  bank: unknown[],
  files: { kind: string; name: string }[],
  answers: { field: string; answer: string }[],
): string[] {
  const p: string[] = [];
  if (!isObject(j) || !Array.isArray(j.fields) || !Array.isArray(j.unmappable)) {
    return ["the Fill plan must be an object with `fields` and `unmappable` lists"];
  }
  const byName = new Map(form.fields.map((f) => [f.name, f]));
  const seen = new Set<string>();
  j.fields.forEach((raw, i) => {
    const at = `fields[${i}]`;
    if (!isObject(raw) || typeof raw.name !== "string" || typeof raw.value !== "string") {
      p.push(`${at} needs a string name and value`);
      return;
    }
    const f = byName.get(raw.name);
    if (f === undefined) {
      p.push(`${at} fills "${raw.name}", which isn't a field of the form`);
      return;
    }
    if (seen.has(raw.name)) p.push(`${raw.name} is filled twice`);
    seen.add(raw.name);
    const src = raw.source;
    if (!isObject(src) || !SOURCE_KINDS.includes(src.kind as SourceKind)) {
      p.push(`${raw.name} needs a source with a kind (${SOURCE_KINDS.join(", ")})`);
      return;
    }
    if (raw.value.trim() === "") p.push(`${raw.name} has an empty value; leave it out instead`);
    if (f.type === "select" || f.type === "multi_select") {
      if (!f.options.some((o) => o.label === raw.value)) {
        p.push(
          `${raw.name}: "${raw.value}" isn't one of its options (${f.options.map((o) => o.label).join(", ")})`,
        );
      }
    }
    switch (src.kind) {
      case "identity": {
        const want = identity[String(src.ref)];
        if (want === undefined || want === null) {
          p.push(`${raw.name}: the Profile has no identity "${String(src.ref)}"`);
        } else if (want !== raw.value) {
          p.push(`${raw.name} must be the Profile's ${String(src.ref)} exactly (${want})`);
        }
        break;
      }
      case "answer_bank": {
        const entry = bank[Number(src.ref)];
        if (!isObject(entry)) {
          p.push(`${raw.name}: the Answer bank has no entry ${String(src.ref)}`);
        } else if (f.type !== "select" && f.type !== "multi_select" && entry.answer !== raw.value) {
          p.push(`${raw.name} must be the Answer bank answer for entry ${String(src.ref)} exactly`);
        }
        break;
      }
      case "tailor": {
        if (f.type !== "file" || !files.some((t) => t.kind === src.ref && t.name === raw.value)) {
          p.push(`${raw.name}: only a Tailor file can fill it, and "${raw.value}" isn't one`);
        }
        break;
      }
      case "application_answer": {
        if (!answers.some((a) => a.field === raw.name && a.answer === raw.value)) {
          p.push(`${raw.name}: the Application holds no such answer from the job seeker`);
        }
        break;
      }
      case "written":
        if (typeof src.basis !== "string" || src.basis === "") {
          p.push(`${raw.name}: a written answer must say its basis`);
        }
        break;
    }
    if (f.type === "file" && src.kind !== "tailor") {
      p.push(`${raw.name} is an upload and can only take a Tailor file`);
    }
  });
  const unmappable = new Map<string, string>();
  j.unmappable.forEach((raw, i) => {
    if (!isObject(raw) || typeof raw.name !== "string" || typeof raw.reason !== "string") {
      p.push(`unmappable[${i}] needs a name and a reason`);
      return;
    }
    if (!byName.has(raw.name))
      p.push(`unmappable[${i}] names "${raw.name}", not a field of the form`);
    if (seen.has(raw.name)) p.push(`${raw.name} is both filled and unmappable`);
    unmappable.set(raw.name, raw.reason);
  });
  for (const f of form.fields) {
    if (f.required && !seen.has(f.name) && !unmappable.has(f.name)) {
      p.push(`${f.name} ("${f.label}") is required but neither filled nor listed as unmappable`);
    }
  }
  return p;
}

export async function applyPlan(dataDir: string, id: string | undefined, input: unknown) {
  if (id === undefined) throw usageError("apply plan: <application-id> is required");
  await assertProfileComplete(dataDir);
  const profile = (await readProfile(dataDir)) as Profile;
  return withWriter(dataDir, "apply plan", async (w) => {
    const app = getApp(await getRecord(dataDir, "application", id), id);
    if (!FILLABLE.includes(app.status as Status)) {
      throw new CoreError(
        "NOT_FILLABLE",
        `${pausedMessage(app)}, so a new Fill plan can't be stored.`,
        { application_id: id },
      );
    }
    const listing = (await getRecord(dataDir, "listing", String(app.listing))) as StoredRecord;
    const target = greenhouseTarget(listing);
    if (target === undefined) throw notFound("greenhouse posting for", id);
    const form = await readGreenhouseForm(target.token, target.jobId, timestamp());
    const files = tailorFiles(app);
    const answers = (app.answers as { field: string; answer: string }[]) ?? [];
    const problems = planProblems(
      input,
      form,
      identityOf(profile),
      (profile.answer_bank as unknown[]) ?? [],
      files,
      answers,
    );
    if (problems.length > 0) {
      throw new CoreError(
        "JUDGMENT_INVALID",
        `The Fill plan was refused and nothing was stored:\n- ${problems.join("\n- ")}`,
        { problems },
      );
    }
    const j = input as { fields: Any[]; unmappable: Any[] };
    const byName = new Map(form.fields.map((f) => [f.name, f]));
    const fields: PlanField[] = j.fields.map((raw) => {
      const f = byName.get(String(raw.name)) as FormField;
      const file = f.type === "file" ? files.find((t) => t.name === raw.value) : undefined;
      return {
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
        value: String(raw.value),
        source: raw.source as PlanField["source"],
        ...(file ? { path: file.path } : {}),
        readback: null,
      };
    });
    const unmappable = j.unmappable.map((raw) => {
      const f = byName.get(String(raw.name)) as FormField;
      return {
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
        options: f.options,
        reason: String(raw.reason),
      };
    });
    const paused = unmappable.length > 0;
    const plan: FillPlan = {
      state: paused ? "paused" : "planned",
      built_at: timestamp(),
      form: {
        url: target.url,
        board_token: target.token,
        job_id: target.jobId,
        fetched_at: form.fetched_at,
      },
      fields,
      unmappable,
      blockers: [],
      readback_at: null,
      browser: null,
    };
    const reason = paused
      ? `Apply can't map ${unmappable.map((u) => `"${u.label}"`).join(", ")} with confidence, so it paused with the partial plan kept.`
      : "Fill plan built from the form, the Profile, the Answer bank and the Tailor files.";
    await saveApplication(
      dataDir,
      w,
      app,
      {
        fill_plan: plan,
        pause: paused ? { code: "UNMAPPABLE_FIELD", reason, at: timestamp() } : null,
      },
      { to: paused ? "paused" : "ready_to_apply", reason },
    );
    return {
      application_id: id,
      outcome: paused ? "paused" : "planned",
      status: paused ? "paused" : "ready_to_apply",
      fields: fields.length,
      unmappable: unmappable.map((u) => ({
        name: u.name,
        label: u.label,
        type: u.type,
        options: u.options,
        reason: u.reason,
      })),
    };
  });
}

// ---------------------------------------------------------------------------------------
// apply answer

export async function applyAnswer(dataDir: string, args: string[], input: unknown) {
  const [id, name] = args;
  if (id === undefined || name === undefined) {
    throw usageError("apply answer: <application-id> <field-name> are required");
  }
  const answer = isObject(input) && typeof input.answer === "string" ? input.answer.trim() : "";
  if (answer === "") throw usageError('apply answer: --input must be {"answer": "<text>"}');
  return withWriter(dataDir, "apply answer", async (w) => {
    const app = getApp(await getRecord(dataDir, "application", id), id);
    const plan = app.fill_plan as FillPlan | null;
    const open = plan?.unmappable.find((u) => u.name === name);
    if (plan === null || open === undefined) {
      throw new CoreError(
        "NOT_UNMAPPABLE",
        `${pausedMessage(app)} has no unmapped field "${name}" waiting for an answer.`,
        { application_id: id },
      );
    }
    if (
      (open.type === "select" || open.type === "multi_select") &&
      !open.options.some((o) => o.label === answer)
    ) {
      throw new CoreError(
        "ANSWER_NOT_AN_OPTION",
        `"${answer}" isn't one of the choices for "${open.label}": ${open.options.map((o) => o.label).join(", ")}.`,
        { application_id: id },
      );
    }
    const at = timestamp();
    const answers = [
      ...((app.answers as unknown[]) ?? []),
      { field: name, label: open.label, answer, at },
    ];
    const unmappable = plan.unmappable.filter((u) => u.name !== name);
    const fields: PlanField[] = [
      ...plan.fields,
      {
        name,
        label: open.label,
        type: open.type,
        required: open.required,
        value: answer,
        source: { kind: "application_answer", ref: name },
        readback: null,
      },
    ];
    const done = unmappable.length === 0;
    const next: FillPlan = { ...plan, fields, unmappable, state: done ? "planned" : "paused" };
    await saveApplication(
      dataDir,
      w,
      app,
      { answers, fill_plan: next, pause: done ? null : app.pause },
      done
        ? {
            to: "ready_to_apply",
            reason: `The job seeker answered "${open.label}"; every field is mapped. The answer stays on this Application only.`,
          }
        : undefined,
    );
    return {
      application_id: id,
      field: name,
      remaining: unmappable.map((u) => u.name),
      status: done ? "ready_to_apply" : "paused",
    };
  });
}

// ---------------------------------------------------------------------------------------
// application submitted (the Handover Checkpoint command)

/**
 * Record Submitted after the job seeker confirms they clicked Submit. Runs only under the
 * Handover Approval the hook spent for this exact action; Apply itself never clicks Submit.
 */
export async function applicationSubmitted(dataDir: string, args: string[]) {
  const [id] = args;
  if (id === undefined || args.length !== 1) {
    throw usageError("application submitted: exactly one <application-id> is required");
  }
  const action = normaliseAction(`application submitted ${id}`);
  const approval = await approvalUsedFor(dataDir, action);
  if (approval === undefined) {
    throw new CoreError(
      "APPROVAL_MISSING",
      `There's no Handover Approval for "${action}", so Submitted wasn't recorded. Show the Handover, ` +
        "ask the job seeker to click Submit themselves and confirm, record their yes with " +
        "`approval record handover`, then run it.",
      { action },
    );
  }
  return withWriter(dataDir, "application submitted", async (w) => {
    const app = getApp(await getRecord(dataDir, "application", id), id);
    if (app.status !== "handover") {
      throw new CoreError(
        "NOT_AT_HANDOVER",
        `${pausedMessage(app)}, not at the Handover, so Submitted can't be recorded. Run \`apply handover\` first.`,
        { application_id: id },
      );
    }
    const at = timestamp();
    const log = [
      ...(app.event_log as EventLogEntry[]),
      {
        at,
        stage: "apply",
        from: "handover",
        to: "submitted",
        reason: "The job seeker confirmed they clicked Submit.",
        approval: {
          id: approval.id,
          checkpoint: approval.checkpoint,
          approved_at: approval.approved_at,
          action,
        },
      } satisfies EventLogEntry,
    ];
    const { id: _i, created_at: _c, updated_at: _u, schema_version: _s, ...fields } = app;
    const saved = await w.put("application", id, {
      ...fields,
      status: "submitted",
      submitted_at: at,
      event_log: log,
    });
    const listing = await getRecord(dataDir, "listing", String(app.listing));
    if (listing !== undefined) await writeTrees(dataDir, [listing], [saved]);
    return { application_id: id, status: "submitted", submitted_at: at };
  });
}

export { STATUSES };
