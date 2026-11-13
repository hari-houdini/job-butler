// The Profile: <data dir>/profile.yaml, human-editable, written only by setup
// (`profile put`). Seven sections plus the optional Companies House key. Setup may write it
// a section at a time; every Stage refuses to start until it is complete (`checkProfile`).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CoreError, usageError } from "./errors.ts";
import { withEditLock, writeThenReplace } from "./store.ts";
import {
  boolean,
  integer,
  isObject,
  list,
  object,
  oneOf,
  optionalString,
  type Problems,
  string,
  stringList,
} from "./validate.ts";
import { parseYaml, stringifyYaml, YamlError } from "./yaml.ts";

export const PROFILE_SECTIONS = [
  "identity",
  "base_resume",
  "targets",
  "sponsorship",
  "filters",
  "autonomy",
  "answer_bank",
] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];
const TOP_LEVEL = [...PROFILE_SECTIONS, "companies_house_key"] as const;

/** Where a Base resume fact came from: a kind, optionally followed by ": <detail>". */
export const FACT_SOURCES = ["resume", "linkedin", "github", "portfolio", "job_seeker"] as const;
export const SENIORITY = [
  "intern",
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "lead",
  "manager",
  "director",
  "executive",
] as const;
export const ATS = ["greenhouse", "lever", "ashby", "workday"] as const;
export const SPONSORSHIP_REGIMES = ["uk-skilled-worker"] as const;
/** Reason categories for the new-entrant flag. Never a date of birth or visa expiry. */
export const NEW_ENTRANT_REASONS = [
  "under_26",
  "graduate_route",
  "student_route",
  "professional_registration",
  "postdoctoral",
] as const;
export const DIVERSITY_DEFAULT = "Prefer not to say";

export type Profile = Partial<Record<(typeof TOP_LEVEL)[number], unknown>>;

/** The Profile lives at <data dir>/profile.yaml (written only by setup). */
export function profilePath(dataDir: string): string {
  return join(dataDir, "profile.yaml");
}

/** The parsed Profile, or undefined when there is none. Unreadable YAML refuses. */
export async function readProfile(dataDir: string): Promise<Profile | undefined> {
  let text: string;
  try {
    text = await readFile(profilePath(dataDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (e) {
    if (!(e instanceof YamlError)) throw e;
    throw new CoreError(
      "PROFILE_INVALID",
      `Your Profile (${profilePath(dataDir)}) can't be read: ${e.message}. ` +
        "Fix that line by hand, or re-run /job-butler:setup.",
      { path: profilePath(dataDir), problems: [e.message] },
    );
  }
  if (value === null) return {};
  if (!isObject(value)) {
    throw new CoreError(
      "PROFILE_INVALID",
      `Your Profile (${profilePath(dataDir)}) must be a set of sections. Re-run /job-butler:setup.`,
      { path: profilePath(dataDir) },
    );
  }
  return value;
}

// ---- shape: wrong values in any section that is present ----

function source(v: unknown, path: string, p: Problems): void {
  const ok =
    typeof v === "string" &&
    FACT_SOURCES.some((s) => v === s || (v.startsWith(`${s}:`) && v.length > s.length + 1));
  if (!ok) {
    p.push(
      `${path} must name where the fact came from: one of ${FACT_SOURCES.join(", ")}, ` +
        `optionally followed by ": <detail>" (got ${JSON.stringify(v)})`,
    );
  }
}

function facts(
  v: unknown,
  path: string,
  p: Problems,
  fields: readonly string[],
  required: readonly string[],
  check?: (item: Record<string, unknown>, at: string) => void,
  extra: readonly string[] = [],
): void {
  list(v, path, p)?.forEach((item, i) => {
    const at = `${path}[${i}]`;
    const o = object(item, at, [...fields, ...extra, "source"], p);
    if (!o) return;
    for (const f of required) string(o[f], `${at}.${f}`, p);
    for (const f of fields) if (!required.includes(f)) optionalString(o[f], `${at}.${f}`, p);
    source(o.source, `${at}.source`, p);
    check?.(o, at);
  });
}

function checkIdentity(v: unknown, p: Problems): void {
  const o = object(v, "identity", ["name", "email", "phone", "country", "location", "links"], p);
  if (!o) return;
  for (const f of ["name", "email", "phone", "country", "location"]) {
    optionalString(o[f], `identity.${f}`, p);
  }
  if (typeof o.email === "string" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) {
    p.push(`identity.email doesn't look like an email address (got ${JSON.stringify(o.email)})`);
  }
  if (o.links !== undefined) {
    list(o.links, "identity.links", p)?.forEach((l, i) => {
      const lo = object(l, `identity.links[${i}]`, ["label", "url"], p);
      if (lo) {
        string(lo.label, `identity.links[${i}].label`, p);
        string(lo.url, `identity.links[${i}].url`, p);
      }
    });
  }
}

const RESUME_KEYS = [
  "reviewed_at",
  "summary",
  "experience",
  "education",
  "skills",
  "projects",
  "certifications",
];

function checkBaseResume(v: unknown, p: Problems): void {
  const o = object(v, "base_resume", RESUME_KEYS, p);
  if (!o) return;
  if (o.reviewed_at !== null && o.reviewed_at !== undefined) {
    string(o.reviewed_at, "base_resume.reviewed_at", p);
  }
  if (o.summary !== undefined && o.summary !== null) {
    const s = object(o.summary, "base_resume.summary", ["text", "source"], p);
    if (s) {
      string(s.text, "base_resume.summary.text", p);
      source(s.source, "base_resume.summary.source", p);
    }
  }
  const optional = (k: string) => o[k] !== undefined;
  if (optional("experience")) {
    facts(
      o.experience,
      "base_resume.experience",
      p,
      ["employer", "title", "location", "start", "end"],
      ["employer", "title", "start"],
      (item, at) => {
        if (item.bullets === undefined) return;
        list(item.bullets, `${at}.bullets`, p)?.forEach((b, j) => {
          const bo = object(b, `${at}.bullets[${j}]`, ["text", "source"], p);
          if (bo) {
            string(bo.text, `${at}.bullets[${j}].text`, p);
            source(bo.source, `${at}.bullets[${j}].source`, p);
          }
        });
      },
      ["bullets"],
    );
  }
  if (optional("education")) {
    facts(
      o.education,
      "base_resume.education",
      p,
      ["institution", "qualification", "start", "end"],
      ["institution", "qualification"],
    );
  }
  if (optional("skills")) facts(o.skills, "base_resume.skills", p, ["name"], ["name"]);
  if (optional("projects")) {
    facts(o.projects, "base_resume.projects", p, ["name", "description", "url"], ["name"]);
  }
  if (optional("certifications")) {
    facts(o.certifications, "base_resume.certifications", p, ["name", "issuer", "date"], ["name"]);
  }
}

function checkTargets(v: unknown, p: Problems): void {
  const keys = ["roles", "seniority", "locations", "remote", "salary_floor", "notice_period"];
  const o = object(v, "targets", keys, p);
  if (!o) return;
  if (o.roles !== undefined) stringList(o.roles, "targets.roles", p);
  if (o.seniority !== undefined) {
    list(o.seniority, "targets.seniority", p)?.forEach((s, i) => {
      oneOf(s, `targets.seniority[${i}]`, SENIORITY, p);
    });
  }
  if (o.locations !== undefined) stringList(o.locations, "targets.locations", p);
  if (o.remote !== undefined) boolean(o.remote, "targets.remote", p);
  if (o.salary_floor !== undefined && o.salary_floor !== null) {
    const s = object(o.salary_floor, "targets.salary_floor", ["amount", "currency", "period"], p);
    if (s) {
      integer(s.amount, "targets.salary_floor.amount", p, 0, 100_000_000);
      if (
        string(s.currency, "targets.salary_floor.currency", p) &&
        !/^[A-Z]{3}$/.test(s.currency as string)
      ) {
        p.push(
          `targets.salary_floor.currency must be a 3-letter currency code like GBP (got ${JSON.stringify(s.currency)})`,
        );
      }
      oneOf(s.period, "targets.salary_floor.period", ["year", "month", "day", "hour"], p);
    }
  }
  if (o.notice_period !== undefined) string(o.notice_period, "targets.notice_period", p);
}

function checkSponsorship(v: unknown, p: Problems): void {
  const o = object(v, "sponsorship", ["needed", "regime", "flags", "flags_skipped"], p);
  if (!o) return;
  if (o.needed !== undefined) boolean(o.needed, "sponsorship.needed", p);
  if (o.regime !== undefined && o.regime !== null) {
    oneOf(o.regime, "sponsorship.regime", SPONSORSHIP_REGIMES, p);
  }
  if (o.flags_skipped !== undefined) boolean(o.flags_skipped, "sponsorship.flags_skipped", p);
  if (o.flags === undefined) return;
  if (!isObject(o.flags)) {
    p.push("sponsorship.flags must be a mapping");
    return;
  }
  for (const k of Object.keys(o.flags)) {
    if (k !== "new_entrant" && k !== "relevant_phd") {
      p.push(
        `sponsorship.flags.${k} can't be stored: Job Butler keeps only the derived flags ` +
          "new_entrant and relevant_phd, never dates of birth, visa expiry or other personal facts",
      );
    }
  }
  const ne = o.flags.new_entrant;
  if (ne !== undefined) {
    const n = object(ne, "sponsorship.flags.new_entrant", ["value", "reason"], p);
    if (n && boolean(n.value, "sponsorship.flags.new_entrant.value", p) && n.value) {
      oneOf(n.reason, "sponsorship.flags.new_entrant.reason", NEW_ENTRANT_REASONS, p);
    }
  }
  const phd = o.flags.relevant_phd;
  if (phd !== undefined) {
    const d = object(phd, "sponsorship.flags.relevant_phd", ["value", "stem"], p);
    if (d && boolean(d.value, "sponsorship.flags.relevant_phd.value", p) && d.value) {
      boolean(d.stem, "sponsorship.flags.relevant_phd.stem", p);
    }
  }
}

const RULE_LISTS = ["companies", "titles", "locations"];

function checkBoard(v: unknown, at: string, p: Problems): void {
  if (!isObject(v)) {
    p.push(`${at} must be a mapping with the company's ATS and board token`);
    return;
  }
  if (!oneOf(v.ats, `${at}.ats`, ATS, p)) return;
  if (v.ats === "workday") {
    const o = object(v, at, ["ats", "tenant", "instance", "site"], p);
    if (!o) return;
    string(o.tenant, `${at}.tenant`, p);
    if (string(o.instance, `${at}.instance`, p) && !/^wd\d+$/.test(o.instance as string)) {
      p.push(`${at}.instance must look like wd5 (got ${JSON.stringify(o.instance)})`);
    }
    string(o.site, `${at}.site`, p);
  } else {
    const o = object(v, at, v.ats === "lever" ? ["ats", "token", "region"] : ["ats", "token"], p);
    if (!o) return;
    string(o.token, `${at}.token`, p);
    if (o.region !== undefined) oneOf(o.region, `${at}.region`, ["global", "eu"], p);
  }
}

function checkFilters(v: unknown, p: Problems): void {
  const o = object(v, "filters", ["allow", "deny", "target_companies"], p);
  if (!o) return;
  for (const side of ["allow", "deny"]) {
    if (o[side] === undefined) continue;
    const s = object(o[side], `filters.${side}`, RULE_LISTS, p);
    if (s) for (const k of RULE_LISTS) stringList(s[k], `filters.${side}.${k}`, p);
  }
  if (o.target_companies === undefined) return;
  list(o.target_companies, "filters.target_companies", p)?.forEach((c, i) => {
    const at = `filters.target_companies[${i}]`;
    const co = object(c, at, ["name", "careers_url", "board", "confirmed_at"], p);
    if (!co) return;
    string(co.name, `${at}.name`, p);
    optionalString(co.careers_url, `${at}.careers_url`, p);
    checkBoard(co.board, `${at}.board`, p);
    string(co.confirmed_at, `${at}.confirmed_at`, p);
  });
}

function checkAutonomy(v: unknown, p: Problems): void {
  const o = object(v, "autonomy", ["enabled", "caps", "fit_threshold", "lists"], p);
  if (!o) return;
  if (o.enabled !== false) {
    p.push(
      `autonomy.enabled must be false: nothing runs on its own in this version (got ${JSON.stringify(o.enabled)})`,
    );
  }
  if (o.fit_threshold !== undefined) integer(o.fit_threshold, "autonomy.fit_threshold", p, 0, 100);
  if (o.caps !== undefined && isObject(o.caps)) {
    for (const [k, n] of Object.entries(o.caps)) integer(n, `autonomy.caps.${k}`, p, 0, 1000);
  } else if (o.caps !== undefined) p.push("autonomy.caps must be a mapping");
  if (o.lists !== undefined && isObject(o.lists)) {
    for (const [k, l] of Object.entries(o.lists)) stringList(l, `autonomy.lists.${k}`, p);
  } else if (o.lists !== undefined) p.push("autonomy.lists must be a mapping");
}

function checkAnswerBank(v: unknown, p: Problems): void {
  list(v, "answer_bank", p)?.forEach((a, i) => {
    const o = object(a, `answer_bank[${i}]`, ["question", "answer", "kind"], p);
    if (!o) return;
    string(o.question, `answer_bank[${i}].question`, p);
    string(o.answer, `answer_bank[${i}].answer`, p);
    if (o.kind !== undefined) oneOf(o.kind, `answer_bank[${i}].kind`, ["general", "diversity"], p);
  });
}

const SECTION_CHECKS: Record<ProfileSection, (v: unknown, p: Problems) => void> = {
  identity: checkIdentity,
  base_resume: checkBaseResume,
  targets: checkTargets,
  sponsorship: checkSponsorship,
  filters: checkFilters,
  autonomy: checkAutonomy,
  answer_bank: checkAnswerBank,
};

/** Problems with the values present (not what is missing). */
export function profileProblems(profile: Profile): Problems {
  const p: Problems = [];
  for (const k of Object.keys(profile)) {
    if (!(TOP_LEVEL as readonly string[]).includes(k)) {
      p.push(`${k} is not a Profile section (expected one of: ${TOP_LEVEL.join(", ")})`);
    }
  }
  for (const s of PROFILE_SECTIONS) {
    if (profile[s] !== undefined) SECTION_CHECKS[s](profile[s], p);
  }
  if (profile.companies_house_key !== undefined && profile.companies_house_key !== null) {
    string(profile.companies_house_key, "companies_house_key", p);
  }
  return p;
}

// ---- completeness: what setup still has to ask for ----

function missingFields(profile: Profile): string[] {
  const m: string[] = [];
  const get = (s: ProfileSection) => (isObject(profile[s]) ? profile[s] : undefined);
  const empty = (v: unknown) =>
    v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  const none = (v: unknown) => !Array.isArray(v) || v.length === 0;

  const id = get("identity");
  if (!id) m.push("identity");
  else for (const f of ["name", "email", "country"]) if (empty(id[f])) m.push(`identity.${f}`);

  const br = get("base_resume");
  if (!br) m.push("base_resume");
  else {
    if (none(br.experience) && none(br.education)) m.push("base_resume.experience");
    if (empty(br.reviewed_at))
      m.push("base_resume.reviewed_at (the job seeker hasn't reviewed it yet)");
  }

  const t = get("targets");
  if (!t) m.push("targets");
  else {
    if (none(t.roles)) m.push("targets.roles");
    if (none(t.seniority)) m.push("targets.seniority");
    if (none(t.locations) && t.remote !== true)
      m.push("targets.locations (or targets.remote: true)");
    if (t.remote === undefined) m.push("targets.remote");
    if (t.salary_floor === undefined) m.push("targets.salary_floor (null for no floor)");
    if (empty(t.notice_period)) m.push("targets.notice_period");
  }

  const sp = get("sponsorship");
  if (!sp) m.push("sponsorship");
  else if (sp.needed === undefined) m.push("sponsorship.needed");
  else if (sp.needed === true && empty(sp.regime)) m.push("sponsorship.regime");

  const f = get("filters");
  if (!f) m.push("filters");
  else
    for (const k of ["allow", "deny", "target_companies"])
      if (f[k] === undefined) m.push(`filters.${k}`);

  const a = get("autonomy");
  if (!a) m.push("autonomy");

  if (!Array.isArray(profile.answer_bank)) m.push("answer_bank");
  return m;
}

export interface ProfileCheck {
  state: "missing" | "incomplete" | "complete";
  missing: string[];
  problems: Problems;
}

/** Whether the Profile exists, is valid and complete. Unreadable YAML refuses. */
export async function checkProfile(dataDir: string): Promise<ProfileCheck> {
  const profile = await readProfile(dataDir);
  if (profile === undefined)
    return { state: "missing", missing: [...PROFILE_SECTIONS], problems: [] };
  const missing = missingFields(profile);
  const problems = profileProblems(profile);
  const state = missing.length === 0 && problems.length === 0 ? "complete" : "incomplete";
  return { state, missing, problems };
}

/** Every Stage entry point calls this: refuse unless the Profile is complete. */
export async function assertProfileComplete(dataDir: string): Promise<void> {
  const check = await checkProfile(dataDir);
  if (check.state === "complete") return;
  if (check.state === "missing") {
    throw new CoreError(
      "PROFILE_INCOMPLETE",
      "There's no Profile yet. Run /job-butler:setup to build one from your resume first.",
      { missing: check.missing, problems: [] },
    );
  }
  const parts = [
    check.missing.length > 0 ? `missing ${check.missing.join(", ")}` : "",
    check.problems.length > 0 ? `invalid: ${check.problems.join("; ")}` : "",
  ].filter(Boolean);
  throw new CoreError(
    check.problems.length > 0 ? "PROFILE_INVALID" : "PROFILE_INCOMPLETE",
    `Your Profile isn't complete (${parts.join("; ")}). Run /job-butler:setup to finish it ` +
      "(you can re-run a single section), or fix profile.yaml by hand.",
    { missing: check.missing, problems: check.problems },
  );
}

// ---- writing (setup only) ----

const HEADER =
  "Job Butler Profile: who you are and the job you want.\n" +
  "Written by /job-butler:setup. You can edit it by hand; every Stage checks it before running.\n" +
  "Every Base resume fact names its source (resume, linkedin, github, portfolio or job_seeker).";

export function serialiseProfile(profile: Profile): string {
  const ordered: Profile = {};
  for (const k of TOP_LEVEL) if (profile[k] !== undefined) ordered[k] = profile[k];
  const header = HEADER.split("\n")
    .map((l) => `# ${l}`)
    .join("\n");
  return `${header}\n${stringifyYaml(ordered)}`;
}

/**
 * Replace the whole Profile, or one section of it. Refuses while a run is in progress
 * and refuses invalid values; completeness is only checked when a Stage starts.
 */
export async function putProfile(
  dataDir: string,
  input: unknown,
  section: string | undefined,
): Promise<{ profile: Profile; check: ProfileCheck }> {
  if (section !== undefined && !(TOP_LEVEL as readonly string[]).includes(section)) {
    throw usageError(
      `Unknown Profile section "${section}". Expected one of: ${TOP_LEVEL.join(", ")}`,
    );
  }
  if (section === undefined && !isObject(input)) {
    throw usageError("profile put: --input must be a JSON object holding Profile sections");
  }
  return withEditLock(dataDir, "profile put", "your Profile", async () => {
    const current = section === undefined ? {} : ((await readProfile(dataDir)) ?? {});
    const next: Profile =
      section === undefined ? (input as Profile) : { ...current, [section]: input };
    const problems = profileProblems(section === undefined ? next : { [section]: input });
    if (problems.length > 0) {
      throw new CoreError("PROFILE_INVALID", `The Profile wasn't saved: ${problems.join("; ")}.`, {
        problems,
      });
    }
    await writeThenReplace(profilePath(dataDir), serialiseProfile(next));
    return { profile: next, check: await checkProfile(dataDir) };
  });
}
