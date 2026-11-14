// The UK Skilled Worker rules (#41) behind the regime-neutral interface in sponsorship.ts:
// employer evidence (the Home Office register, through #40's Employer record), role and wage
// evidence (SOC 2020 eligibility and going rates, parsed from GOV.UK HTML) and the wording
// lexicon. Sources: docs/research/uk-sponsorship-evidence.md (branch research/uk-sponsorship-evidence).
//
// Figures change with each Statement of Changes. Every one of them is a named constant here, the
// one place to change them; the occupation and going-rate tables are downloaded, not hard-coded.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { now, timestamp } from "./env.ts";
import { CoreError } from "./errors.ts";
import { decodeEntities, htmlToText } from "./html-text.ts";
import { httpGet } from "./net.ts";
import type { Evidence, RoleEvidence, SponsorshipRegime } from "./sponsorship.ts";
import { type StoredRecord, writeThenReplace } from "./store.ts";
import { isObject } from "./validate.ts";

/** General Skilled Worker salary threshold (a year), from 22 July 2025. */
export const GENERAL_THRESHOLD = 41_700;
/** Going rates are for this many hours a week; other patterns are pro-rated. */
export const STANDARD_HOURS = 37.5;
/** Discounts the job seeker's derived flags can unlock ("when you can be paid less"). */
export const DISCOUNTS = {
  new_entrant: { label: "new entrant", percent: 70, floor: 33_400 },
  phd_stem: { label: "STEM PhD", percent: 80, floor: 33_400 },
  phd_other: { label: "non-STEM PhD", percent: 90, floor: 37_500 },
} as const;

export const OCCUPATIONS_URL =
  "https://www.gov.uk/government/publications/skilled-worker-visa-eligible-occupations/skilled-worker-visa-eligible-occupations-and-codes";
export const GOING_RATES_URL =
  "https://www.gov.uk/government/publications/skilled-worker-visa-going-rates-for-eligible-occupations/skilled-worker-visa-going-rates-for-eligible-occupation-codes";
/** The tables are refreshed at most this often. */
export const REFRESH_DAYS = 7;

export const gbp = (n: number): string =>
  `£${Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+$)/g, ",")}`;

// --- the tables ---------------------------------------------------------------------------

export interface Occupation {
  code: string;
  job_type: string;
  titles: string[];
  eligibility: string;
}
export interface GoingRate {
  code: string;
  standard: number;
}
export interface UkTables {
  /** When the tables were last downloaded successfully (ISO 8601 UTC). */
  downloaded_at: string;
  occupation_url: string;
  going_rate_url: string;
  /** The "Updated ..." date each GOV.UK page states, if it states one. */
  occupations_updated: string | null;
  going_rates_updated: string | null;
  last_error: { at: string; message: string } | null;
  occupations: Occupation[];
  going_rates: GoingRate[];
}
export interface TablesStatus {
  as_of: string | null;
  stale: boolean;
  stale_note: string | null;
}

const tablesPath = (dataDir: string) => join(dataDir, "cache", "uk-sponsorship-tables.json");

export async function readTables(dataDir: string): Promise<UkTables | null> {
  try {
    return JSON.parse(await readFile(tablesPath(dataDir), "utf8")) as UkTables;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export function tablesStatus(t: UkTables | null): TablesStatus {
  if (t === null) return { as_of: null, stale: false, stale_note: null };
  const as_of = t.downloaded_at.slice(0, 10);
  const stale = t.last_error !== null;
  return { as_of, stale, stale_note: stale ? `data may be stale (as of ${as_of})` : null };
}

function cellText(html: string): string {
  return decodeEntities(htmlToText(html)).replace(/\s+/g, " ").trim();
}

function cellItems(html: string): string[] {
  return html
    .split(/<\/li>|<br\s*\/?>|<\/p>/i)
    .map(cellText)
    .map((s) => s.replace(/^-\s*/, ""))
    .filter((s) => s !== "");
}

/** Every table on the page as its header cells (lower case) and body rows (cell HTML). */
function tablesIn(html: string): { headers: string[]; rows: string[][] }[] {
  const out: { headers: string[]; rows: string[][] }[] = [];
  for (const t of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const rows = [...t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((r) =>
      [...r[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => c[1] as string),
    );
    const [head, ...body] = rows;
    if (head) out.push({ headers: head.map((h) => cellText(h).toLowerCase()), rows: body });
  }
  return out;
}

const column = (headers: string[], re: RegExp) => headers.findIndex((h) => re.test(h));

export function parseOccupations(html: string): Occupation[] {
  const out: Occupation[] = [];
  for (const t of tablesIn(html)) {
    const iCode = column(t.headers, /code/);
    const iType = column(t.headers, /job type/);
    const iTitles = column(t.headers, /related/);
    const iElig = column(t.headers, /eligib/);
    if (iCode < 0 || iElig < 0) continue;
    for (const r of t.rows) {
      const code = cellText(r[iCode] ?? "");
      if (!/^\d{4}$/.test(code)) continue;
      out.push({
        code,
        job_type: iType < 0 ? "" : cellText(r[iType] ?? ""),
        titles: iTitles < 0 ? [] : cellItems(r[iTitles] ?? ""),
        eligibility: cellText(r[iElig] ?? ""),
      });
    }
  }
  return out;
}

export function parseGoingRates(html: string): GoingRate[] {
  const out: GoingRate[] = [];
  for (const t of tablesIn(html)) {
    const iCode = column(t.headers, /code/);
    const iRate = column(t.headers, /standard|going rate/);
    if (iCode < 0 || iRate < 0) continue;
    for (const r of t.rows) {
      const code = cellText(r[iCode] ?? "");
      const amount = /£\s*([\d,]+)/.exec(cellText(r[iRate] ?? ""));
      if (!/^\d{4}$/.test(code) || amount === null) continue;
      out.push({ code, standard: Number((amount[1] as string).replace(/,/g, "")) });
    }
  }
  return out;
}

const updatedOn = (html: string) =>
  /Updated\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/.exec(html)?.[1] ?? null;

async function page(url: string, what: string): Promise<string> {
  const r = await httpGet(url);
  if (r.status < 200 || r.status >= 300) throw new Error(`the ${what} page answered ${r.status}`);
  return r.body;
}

/**
 * Download both tables unless a copy under REFRESH_DAYS old exists. Call inside `withWriter`.
 * A failure keeps the last good copy and records the error; it never throws.
 */
export async function refreshTables(dataDir: string): Promise<{ refreshed: boolean }> {
  const have = await readTables(dataDir);
  if (have !== null) {
    const age = (now().getTime() - Date.parse(have.downloaded_at)) / 86_400_000;
    if (age < REFRESH_DAYS) return { refreshed: false };
  }
  try {
    const occHtml = await page(OCCUPATIONS_URL, "eligible occupations");
    const rateHtml = await page(GOING_RATES_URL, "going rates");
    const occupations = parseOccupations(occHtml);
    const going_rates = parseGoingRates(rateHtml);
    if (occupations.length === 0 || going_rates.length === 0) {
      throw new Error("the GOV.UK tables no longer have the columns Job Butler reads");
    }
    const fresh: UkTables = {
      downloaded_at: timestamp(),
      occupation_url: OCCUPATIONS_URL,
      going_rate_url: GOING_RATES_URL,
      occupations_updated: updatedOn(occHtml),
      going_rates_updated: updatedOn(rateHtml),
      last_error: null,
      occupations,
      going_rates,
    };
    await mkdir(join(dataDir, "cache"), { recursive: true });
    await writeThenReplace(tablesPath(dataDir), `${JSON.stringify(fresh, null, 2)}\n`);
    return { refreshed: true };
  } catch (e) {
    if (have !== null) {
      const failed: UkTables = {
        ...have,
        last_error: { at: timestamp(), message: (e as Error).message },
      };
      await writeThenReplace(tablesPath(dataDir), `${JSON.stringify(failed, null, 2)}\n`);
    }
    return { refreshed: false };
  }
}

export function tablesUnavailable(): CoreError {
  return new CoreError(
    "TABLES_UNAVAILABLE",
    "Couldn't download the GOV.UK occupation and going-rate tables and there is no earlier copy. Try again later.",
  );
}

// --- employer evidence --------------------------------------------------------------------

const A_RATED = /^worker\s*\(\s*a\b|^a\s*\(\s*(?:premium|sme\+)\s*\)/i;
const unknown = (reason: string, rule: string, citation: string, evidence: string[] = []) =>
  ({
    status: "unknown",
    result: `unknown: ${reason}`,
    rule,
    citation,
    evidence,
  }) satisfies Evidence;

const EMPLOYER_RULE = "On the Home Office register with an A rating on the Skilled Worker route";

function employerEvidence(employer: StoredRecord | undefined): Evidence {
  if (employer === undefined) {
    return unknown(
      "the employer hasn't been matched to the register yet",
      EMPLOYER_RULE,
      "Home Office register of licensed sponsors (no Employer record)",
    );
  }
  const asOf =
    typeof employer.register_as_of === "string" ? employer.register_as_of : "unknown date";
  const citation = `Home Office register as of ${asOf}`;
  const agency = isObject(employer.agency) ? employer.agency : {};
  if (employer.status === "agency") {
    return unknown(
      String(agency.badge ?? "agency, end client not named"),
      EMPLOYER_RULE,
      citation,
      [String(employer.unmatched_reason ?? "")],
    );
  }
  if (employer.status !== "matched" || !isObject(employer.register_entry)) {
    const why =
      employer.status === "needs_judgment"
        ? "the match is waiting for a judgment"
        : "no high-confidence register match";
    return unknown(
      why,
      EMPLOYER_RULE,
      citation,
      [String(employer.unmatched_reason ?? "")].filter(Boolean),
    );
  }
  const entry = employer.register_entry as {
    organisation_name: string;
    town: string;
    entries: { type_rating: string; route: string }[];
  };
  const where = `${entry.organisation_name}, ${entry.town}`;
  const skilled = entry.entries.filter((e) => e.route.trim().toLowerCase() === "skilled worker");
  const evidence = entry.entries.map(
    (e) => `register: ${where}: ${e.type_rating.trim()}, ${e.route.trim()}`,
  );
  if (skilled.length === 0) {
    return {
      status: "fail",
      result: "on the register, but not on the Skilled Worker route",
      rule: EMPLOYER_RULE,
      citation,
      evidence,
    };
  }
  if (skilled.some((e) => A_RATED.test(e.type_rating.trim()))) {
    return {
      status: "ok",
      result: "A-rated Skilled Worker sponsor",
      rule: EMPLOYER_RULE,
      citation,
      evidence,
    };
  }
  return {
    status: "fail",
    result: `not A-rated: ${skilled.map((e) => e.type_rating.trim()).join(", ")}`,
    rule: EMPLOYER_RULE,
    citation,
    evidence,
  };
}

// --- role and wage evidence ---------------------------------------------------------------

const LEVEL_WORDS = new Set([
  "senior",
  "junior",
  "lead",
  "principal",
  "staff",
  "graduate",
  "sr",
  "jr",
  "associate",
  "mid",
  "trainee",
]);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const titleWords = (s: string) =>
  words(s.replace(/\([^)]*\)/g, " "))
    .split(" ")
    .filter((w) => w !== "" && !LEVEL_WORDS.has(w))
    .join(" ");

/** Occupations whose "related job titles" the Listing's title equals or contains. */
export function occupationsFor(title: string, tables: UkTables): Occupation[] {
  const t = ` ${titleWords(title)} `;
  return tables.occupations.filter((o) =>
    o.titles.some((r) => {
      const w = titleWords(r);
      return w !== "" && t.includes(` ${w} `);
    }),
  );
}

export interface Salary {
  annual: number;
  text: string;
  note: string;
}

/** The base salary as a year's pay at 37.5 hours, from the advert's text; bottom of any range. */
export function parseSalary(text: string | null | undefined): Salary | string {
  const raw = (text ?? "").trim();
  if (raw === "") return "no salary advertised";
  if (/\bote\b|on[- ]target/i.test(raw))
    return "on-target earnings include pay that isn't base salary";
  if (!/£|\bgbp\b/i.test(raw)) return "the salary isn't stated in pounds";
  const amounts: number[] = [];
  for (const m of raw.matchAll(
    /(\d[\d,]*(?:\.\d+)?)\s*(k\b)?(?!\s*(?:hours?|hrs?|days?|weeks?|%))/gi,
  )) {
    const n = Number((m[1] as string).replace(/,/g, "")) * (m[2] ? 1000 : 1);
    if (Number.isFinite(n) && n > 0) amounts.push(n);
  }
  if (amounts.length === 0) return "no amount found in the salary text";
  const low = Math.min(...amounts);
  let annual: number;
  let per: string;
  if (/per\s+hour|an?\s+hour|\/\s*h(?:ou)?r|hourly|per\s+hr/i.test(raw)) {
    annual = low * STANDARD_HOURS * 52;
    per = `${gbp(low)} an hour x ${STANDARD_HOURS} hours x 52 weeks`;
  } else if (/per\s+day|a\s+day|daily/i.test(raw)) {
    annual = low * 5 * 52;
    per = `${gbp(low)} a day x 5 days x 52 weeks`;
  } else if (/per\s+week|a\s+week|weekly/i.test(raw)) {
    annual = low * 52;
    per = `${gbp(low)} a week x 52`;
  } else if (/per\s+month|a\s+month|monthly/i.test(raw)) {
    annual = low * 12;
    per = `${gbp(low)} a month x 12`;
  } else if (low >= 1000) {
    annual = low;
    per = `${gbp(low)} a year`;
  } else {
    return "no pay period (year, day or hour) in the salary text";
  }
  const range = amounts.length > 1 ? ", the bottom of the range" : "";
  return {
    annual: Math.round(annual),
    text: raw,
    note: `salary "${raw}" read as ${gbp(annual)} a year (${per}${range}; base pay only)`,
  };
}

export interface Flags {
  newEntrant: boolean;
  phd: "stem" | "other" | null;
}

export function flagsOf(sponsorship: unknown): Flags {
  const f = isObject(sponsorship) && isObject(sponsorship.flags) ? sponsorship.flags : {};
  const ne = isObject(f.new_entrant) && f.new_entrant.value === true;
  const phd = isObject(f.relevant_phd) && f.relevant_phd.value === true ? f.relevant_phd : null;
  return { newEntrant: ne, phd: phd === null ? null : phd.stem === true ? "stem" : "other" };
}

export interface Required {
  amount: number;
  rule: string;
  discount: string | null;
}

/** The lowest pay the flags allow: the higher of the threshold and going rate, or a discount. */
export function requiredPay(going: number | null, code: string, flags: Flags): Required {
  const base = going === null ? "" : ` and the ${code} going rate ${gbp(going)}`;
  let best: Required = {
    amount: Math.max(GENERAL_THRESHOLD, going ?? 0),
    rule:
      going === null
        ? `Pay at least ${gbp(GENERAL_THRESHOLD)} (going rate unknown)`
        : `Pay at least ${gbp(Math.max(GENERAL_THRESHOLD, going))}: the higher of ${gbp(GENERAL_THRESHOLD)}${base}`,
    discount: null,
  };
  const options = [
    flags.newEntrant ? DISCOUNTS.new_entrant : null,
    flags.phd === "stem" ? DISCOUNTS.phd_stem : null,
    flags.phd === "other" ? DISCOUNTS.phd_other : null,
  ];
  for (const d of options) {
    if (d === null) continue;
    const amount = Math.max(d.floor, going === null ? 0 : Math.round((going * d.percent) / 100));
    if (amount < best.amount) {
      best = {
        amount,
        rule:
          going === null
            ? `Pay at least ${gbp(amount)}: the ${gbp(d.floor)} floor for a ${d.label} (going rate unknown)`
            : `Pay at least ${gbp(amount)}: ${d.percent}% of the ${code} going rate ${gbp(going)}, floor ${gbp(d.floor)} (${d.label})`,
        discount: d.label,
      };
    }
  }
  return best;
}

const ROLE_RULE = "SOC 2020 code on the Higher Skilled list";
const SEVERITY = ["Higher Skilled", "Medium Skilled", "Ineligible"];

interface RoleAndPay {
  role: Evidence;
  pay: Evidence;
  soc: string[];
  salary: number | null;
  required: number | null;
  discount: string | null;
}

function roleAndPay(listing: StoredRecord, flags: Flags, tables: UkTables | null): RoleAndPay {
  const status = tablesStatus(tables);
  const asOf =
    status.as_of === null ? "no copy" : `as of ${status.as_of}${status.stale ? ", stale" : ""}`;
  const roleCite = `GOV.UK eligible occupations table ${asOf} (SOC 2020)`;
  const payCite = `GOV.UK going rates table ${asOf}; ${gbp(GENERAL_THRESHOLD)} general threshold`;
  const salary = parseSalary(typeof listing.salary === "string" ? listing.salary : null);
  const none = {
    soc: [] as string[],
    salary: typeof salary === "string" ? null : salary.annual,
    required: null,
    discount: null,
  };

  const found = tables === null ? [] : occupationsFor(String(listing.title ?? ""), tables);
  let role: Evidence;
  if (tables === null) {
    role = unknown("the occupation table couldn't be downloaded", ROLE_RULE, roleCite);
  } else if (found.length === 0) {
    role = unknown(
      `no SOC 2020 code lists "${listing.title}" as a related job title`,
      ROLE_RULE,
      roleCite,
    );
  } else {
    const higher = found.filter((o) => o.eligibility === "Higher Skilled");
    const label = found.map((o) => `${o.code} ${o.eligibility}`).join(", ");
    const evidence = found.map((o) => `${o.code} ${o.job_type}: ${o.eligibility}`);
    if (higher.length === found.length)
      role = { status: "ok", result: label, rule: ROLE_RULE, citation: roleCite, evidence };
    else if (higher.length > 0) {
      role = {
        status: "unknown",
        result: `unknown: the title fits codes that disagree (${label})`,
        rule: ROLE_RULE,
        citation: roleCite,
        evidence,
      };
    } else {
      const worst = [...found].sort(
        (a, b) => SEVERITY.indexOf(b.eligibility) - SEVERITY.indexOf(a.eligibility),
      )[0] as Occupation;
      role = {
        status: "fail",
        result: `${worst.code} ${worst.eligibility}`,
        rule: ROLE_RULE,
        citation: roleCite,
        evidence,
      };
    }
  }

  const rates = found.flatMap((o) => tables?.going_rates.filter((g) => g.code === o.code) ?? []);
  const going = rates.length > 0 ? Math.max(...rates.map((r) => r.standard)) : null;
  const code = found.map((o) => o.code).join("/");
  const req = requiredPay(going, code, flags);
  const base = {
    soc: found.map((o) => o.code),
    salary: none.salary,
    required: req.amount,
    discount: req.discount,
  };
  if (typeof salary === "string") {
    return { role, pay: unknown(salary, req.rule, payCite), ...base };
  }
  const evidence = [salary.note, req.rule];
  if (salary.annual < req.amount) {
    return {
      role,
      pay: {
        status: "fail",
        result: `${gbp(salary.annual)} is under ${gbp(req.amount)}`,
        rule: req.rule,
        citation: payCite,
        evidence,
      },
      ...base,
    };
  }
  if (going === null) {
    return {
      role,
      pay: unknown(
        "the going rate for this role isn't known, so only the floor was checked",
        req.rule,
        payCite,
        evidence,
      ),
      ...base,
    };
  }
  return {
    role,
    pay: {
      status: "ok",
      result: `${gbp(salary.annual)} meets ${gbp(req.amount)}`,
      rule: req.rule,
      citation: payCite,
      evidence,
    },
    ...base,
  };
}

// --- wording lexicon ----------------------------------------------------------------------
// Observed conventions, not regulated wording (research section 3). Negative wording overrides
// every check; "right to work" alone is boilerplate and only noted.

const NEGATIVE: RegExp[] = [
  /\b(?:unable to|not able to|cannot|can ?not|can'?t|will not|won'?t|do not|don'?t|does not|doesn'?t|not in a position to|not currently able to)\s+(?:\w+\s+){0,2}?sponsor/i,
  /\bno\s+(?:visa\s+)?sponsorship\b/i,
  /\bsponsorship\s+(?:is\s+)?(?:not\s+(?:available|offered|provided)|unavailable)/i,
  /\balready\s+(?:have|hold|possess)\s+(?:the\s+)?(?:full\s+)?right to work in the (?:uk|united kingdom)/i,
  /\b(?:uk|british)\s*(?:\/|or)\s*irish\s+citizens?\s+only/i,
  /\bsettled status only\b/i,
  /\b(?:sc|dv)\s+(?:security\s+)?clearance\b|\bsecurity clearance\s*\(?(?:sc|dv)\b/i,
];
const WEAK: RegExp[] = [
  /\b(?:must|need to)\s+have\s+(?:the\s+)?right to work in the (?:uk|united kingdom)/i,
];
const POSITIVE: RegExp[] = [
  /\bvisa sponsorship (?:is )?available\b/i,
  /\bwe (?:can |do |will )?sponsor\b/i,
  /\brelocation and visa support\b/i,
  /\bopen to candidates requiring sponsorship\b/i,
];

export const ukRegime: SponsorshipRegime<UkTables | null> = {
  id: "uk-skilled-worker",
  name: "UK Skilled Worker",
  employerEvidence: (_listing, employer) => employerEvidence(employer),
  roleEvidence(listing, sponsorship, tables): RoleEvidence {
    const { role, pay, ...stored } = roleAndPay(listing, flagsOf(sponsorship), tables);
    return { role, pay, stored };
  },
  wordingLexicon: { negative: NEGATIVE, weak: WEAK, positive: POSITIVE },
  dataStatus: (t) => tablesStatus(t),
};
