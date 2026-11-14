// Employer matching (#40): match a Listing's employer to the UK sponsor register with a tiered,
// deterministic matcher, and cache the result as an Employer record the job seeker can correct.
//
// Tiers, in order, each stopping at the first that gives a high-confidence match:
//   1. exact:  the normalised name equals a register name (town only tells entries apart);
//   2. fuzzy:  a similar name in an agreeing town (the town is required). It counts only when
//              Companies House verifies it, so it needs the job seeker's key (#24). One candidate
//              is taken; two or three go to the model as JSON and it may only pick one;
//   3. Companies House (only with the job seeker's own key): verifies a fuzzy match (an active
//              company with that name in that town) and attaches the company number; when
//              tiers 1 and 2 found nothing it looks the brand up for its legal name and matches
//              that against the register.
// Anything short of high confidence is "unmatched": never a guess, and never "not sponsored".
import { timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { httpGet } from "./net.ts";
import { readProfile } from "./profile.ts";
import {
  loadRegister,
  normaliseName,
  normaliseTown,
  type RegisterGroup,
  readRegisterMeta,
  refreshRegister,
  registerStatus,
  townsAgree,
} from "./sponsor.ts";
import {
  getRecord,
  listRecords,
  notFound,
  type StoredRecord,
  type StoreWriter,
  withWriter,
} from "./store.ts";

/**
 * Minimum trigram similarity (Dice, 0 to 1) for a fuzzy candidate. OPEN CALIBRATION ITEM: this is
 * a placeholder chosen by hand. Measure it with `employer calibrate` over a hand-labelled sample of
 * real name pairs (core/src/employer-calibration.ts), then set it from that report.
 */
export const FUZZY_THRESHOLD = 0.85;
/** The model chooses among at most this many fuzzy candidates. */
export const MAX_FUZZY_CANDIDATES = 3;
export const AGENCY_BADGE = "agency, end client not named";
const NEEDS_KEY_REASON =
  "A near match needs a Companies House key to verify it. Add the key in setup, or correct the match by hand.";

const COMPANIES_HOUSE = "https://api.company-information.service.gov.uk";

// --- name similarity ---------------------------------------------------------------------

function trigrams(s: string): Map<string, number> {
  const padded = ` ${s} `;
  const out = new Map<string, number>();
  for (let i = 0; i + 3 <= padded.length; i++) {
    const g = padded.slice(i, i + 3);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity of two normalised names over character trigrams. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = trigrams(a);
  const y = trigrams(b);
  let shared = 0;
  let total = 0;
  for (const [g, n] of x) {
    shared += Math.min(n, y.get(g) ?? 0);
    total += n;
  }
  for (const n of y.values()) total += n;
  return total === 0 ? 0 : (2 * shared) / total;
}

// --- Companies House ---------------------------------------------------------------------

interface ChItem {
  title: string;
  company_number: string;
  company_status: string;
  locality: string;
}

/** A Companies House client for one run; remembers answers and whether it was usable. */
class CompaniesHouse {
  readonly key: string;
  /** Set once the key is refused: no further requests are made. */
  unavailable: string | null = null;
  /** The latest request that failed for another reason; later requests still try. */
  problem: string | null = null;
  used = false;
  private cache = new Map<string, unknown>();

  constructor(key: string) {
    this.key = key;
  }

  private async get(path: string): Promise<Record<string, unknown> | null> {
    if (this.unavailable !== null) return null;
    if (this.cache.has(path)) return this.cache.get(path) as Record<string, unknown> | null;
    let result: Record<string, unknown> | null = null;
    try {
      const auth = Buffer.from(`${this.key}:`).toString("base64");
      const res = await httpGet(`${COMPANIES_HOUSE}${path}`, { authorization: `Basic ${auth}` });
      this.used = true;
      if (res.status === 401 || res.status === 403) {
        this.unavailable = "Companies House refused the key";
      } else if (res.status >= 200 && res.status < 300) {
        result = JSON.parse(res.body) as Record<string, unknown>;
      } else {
        this.problem = `Companies House answered ${res.status}`;
      }
    } catch (e) {
      this.problem = (e as Error).message;
    }
    this.cache.set(path, result);
    return result;
  }

  async search(name: string): Promise<ChItem[] | null> {
    const body = await this.get(
      `/search/companies?q=${encodeURIComponent(name)}&items_per_page=10`,
    );
    if (body === null) return null;
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    return items.map((i) => ({
      title: String(i.title ?? ""),
      company_number: String(i.company_number ?? ""),
      company_status: String(i.company_status ?? ""),
      locality: String((i.address as Record<string, unknown> | undefined)?.locality ?? ""),
    }));
  }

  async sicCodes(companyNumber: string): Promise<string[] | null> {
    const body = await this.get(`/company/${companyNumber}`);
    if (body === null) return null;
    return Array.isArray(body.sic_codes) ? (body.sic_codes as string[]) : [];
  }

  /** The company number when an active company called `group`'s name sits in its town. */
  async verify(group: RegisterGroup): Promise<string | null> {
    const items = await this.search(group.organisation_name);
    const hit = items?.find(
      (i) =>
        i.company_status === "active" &&
        group.names.includes(normaliseName(i.title)) &&
        (group.town === "" || townsAgree(i.locality, group.town)),
    );
    return hit?.company_number ?? null;
  }
}

// --- the matcher -------------------------------------------------------------------------

interface Candidate {
  key: string;
  organisation_name: string;
  town: string;
  score: number;
}

type Outcome =
  | {
      status: "matched";
      tier: "exact" | "fuzzy" | "companies_house";
      group: RegisterGroup;
      company_number: string | null;
    }
  | { status: "unmatched"; reason: string }
  | { status: "needs_judgment"; candidates: Candidate[] };

interface Index {
  groups: RegisterGroup[];
  byName: Map<string, RegisterGroup[]>;
}

function buildIndex(groups: RegisterGroup[]): Index {
  const byName = new Map<string, RegisterGroup[]>();
  for (const g of groups) {
    for (const n of g.names) byName.set(n, [...(byName.get(n) ?? []), g]);
  }
  return { groups, byName };
}

function exactMatch(index: Index, name: string, town: string | undefined): Outcome | undefined {
  const hits = index.byName.get(normaliseName(name)) ?? [];
  if (hits.length === 0) return undefined;
  if (hits.length === 1) {
    return {
      status: "matched",
      tier: "exact",
      group: hits[0] as RegisterGroup,
      company_number: null,
    };
  }
  const here = town === undefined ? [] : hits.filter((g) => townsAgree(g.town, town));
  if (here.length === 1) {
    return {
      status: "matched",
      tier: "exact",
      group: here[0] as RegisterGroup,
      company_number: null,
    };
  }
  return {
    status: "unmatched",
    reason: "Several register entries share this name and the town doesn't tell them apart.",
  };
}

function fuzzyCandidates(
  index: Index,
  name: string,
  town: string,
): (Candidate & { group: RegisterGroup })[] {
  const found: (Candidate & { group: RegisterGroup })[] = [];
  for (const g of index.groups) {
    if (!townsAgree(g.town, town)) continue;
    const score = Math.max(...g.names.map((n) => nameScore(name, n)));
    if (score >= FUZZY_THRESHOLD) {
      found.push({
        key: g.key,
        organisation_name: g.organisation_name,
        town: g.town,
        score: Math.round(score * 1000) / 1000,
        group: g,
      });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, MAX_FUZZY_CANDIDATES);
}

async function matchName(
  index: Index,
  ch: CompaniesHouse | undefined,
  name: string,
  town: string | undefined,
  judgment: { choice: string | null } | undefined,
): Promise<Outcome> {
  // Tier 1: exact.
  const exact = exactMatch(index, name, town);
  if (exact?.status === "unmatched") return exact;
  if (exact?.status === "matched") {
    return { ...exact, company_number: (await ch?.verify(exact.group)) ?? null };
  }

  // Tier 2: fuzzy, town required, and only counted once Companies House verifies it (#24).
  if (town !== undefined && normaliseTown(town) !== "") {
    const found = fuzzyCandidates(index, name, town);
    if (found.length > 0 && ch === undefined) {
      return { status: "unmatched", reason: NEEDS_KEY_REASON };
    }
    let chosen: RegisterGroup | undefined;
    if (found.length === 1) chosen = found[0]?.group;
    else if (found.length > 1) {
      if (judgment === undefined) {
        return {
          status: "needs_judgment",
          candidates: found.map(({ group: _g, ...c }) => c),
        };
      }
      if (judgment.choice !== null) {
        chosen = found.find((c) => c.key === judgment.choice)?.group;
        if (chosen === undefined) {
          throw new CoreError(
            "JUDGMENT_NOT_A_CANDIDATE",
            "The judgment chose an entry that isn't one of the candidates. Choose one of them, or null.",
            { candidates: found.map((c) => c.key) },
          );
        }
      } else
        return {
          status: "unmatched",
          reason: "None of the near matches was judged the same employer.",
        };
    }
    if (chosen !== undefined) {
      if (ch === undefined) return { status: "unmatched", reason: NEEDS_KEY_REASON };
      const number = await ch.verify(chosen);
      if (number !== null)
        return { status: "matched", tier: "fuzzy", group: chosen, company_number: number };
      return {
        status: "unmatched",
        reason:
          ch.unavailable !== null || ch.problem !== null
            ? `A near match needs Companies House to verify it, and ${ch.unavailable ?? ch.problem}.`
            : "A near match couldn't be verified as an active company in that town at Companies House.",
      };
    }

    // Tier 3: with a key, look the brand up for its legal name.
    if (ch !== undefined) {
      const items = await ch.search(name);
      for (const item of items ?? []) {
        if (item.company_status !== "active" || !townsAgree(item.locality, town)) continue;
        const named = (index.byName.get(normaliseName(item.title)) ?? []).filter((g) =>
          townsAgree(g.town, town),
        );
        if (named.length === 1) {
          return {
            status: "matched",
            tier: "companies_house",
            group: named[0] as RegisterGroup,
            company_number: item.company_number,
          };
        }
      }
    }
  }
  return {
    status: "unmatched",
    reason:
      town === undefined || normaliseTown(town) === ""
        ? "No exact name match, and a near match needs the town."
        : "No high-confidence match on the register.",
  };
}

// --- agencies ----------------------------------------------------------------------------

const AGENCY_NAME =
  /\b(recruitment|recruiters?|resourcing|staffing|talent|headhunters?|search (?:and|&) selection|executive search|employment (?:agency|business)|manpower|personnel)\b/i;
const OUR_CLIENT =
  /\b(?:our client|my client|on behalf of (?:our|a|one of our) (?:client|customer)s?|confidential client)\b/i;

async function detectAgency(
  ch: CompaniesHouse | undefined,
  company: string,
  description: string | undefined,
): Promise<string[]> {
  const signals: string[] = [];
  if (AGENCY_NAME.test(company)) signals.push("name pattern");
  if (description !== undefined && OUR_CLIENT.test(description)) signals.push("our client wording");
  if (ch !== undefined) {
    const items = await ch.search(company);
    const own = items?.find((i) => normaliseName(i.title) === normaliseName(company));
    const sic = own === undefined ? null : await ch.sicCodes(own.company_number);
    if (sic?.some((c) => c.startsWith("78"))) signals.push("SIC 78xxx");
  }
  return signals;
}

// --- Employer records --------------------------------------------------------------------

/**
 * How alike a Listing's company and a register name are: the score the fuzzy step thresholds,
 * and the one `employer calibrate` measures. Both names are normalised first.
 */
export function nameScore(company: string, registerName: string): number {
  return similarity(normaliseName(company), normaliseName(registerName));
}

function slug(s: string): string {
  return s.replace(/ /g, "-");
}

/** An Employer's id: its normalised brand name, and its town when known. */
export function employerId(company: string, town: string | undefined): string {
  const t = town === undefined ? "" : normaliseTown(town);
  return t === "" ? slug(normaliseName(company)) : `${slug(normaliseName(company))}:${slug(t)}`;
}

interface Agency {
  detected: boolean;
  signals: string[];
  end_client: string | null;
  badge: string | null;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function agencyOf(record: StoredRecord | undefined): Agency | undefined {
  const a = record?.agency as Agency | undefined;
  return a?.detected ? a : undefined;
}

function entryOf(g: RegisterGroup) {
  return {
    organisation_name: g.organisation_name,
    town: g.town,
    county: g.county,
    entries: g.entries,
  };
}

function matchFields(outcome: Outcome, verifiedByCh: boolean): Record<string, unknown> {
  if (outcome.status === "matched") {
    return {
      status: "matched",
      register_entry: entryOf(outcome.group),
      company_number: outcome.company_number,
      verified_by_companies_house: outcome.company_number !== null || verifiedByCh,
      match_tier: outcome.tier,
      confidence: "high",
      unmatched_reason: null,
      candidates: [],
    };
  }
  return {
    status: outcome.status,
    register_entry: null,
    company_number: null,
    verified_by_companies_house: false,
    match_tier: null,
    confidence: null,
    unmatched_reason: outcome.status === "unmatched" ? outcome.reason : null,
    candidates: outcome.status === "needs_judgment" ? outcome.candidates : [],
  };
}

interface Session {
  index: Index;
  ch: CompaniesHouse | undefined;
  as_of: string | null;
  stale: boolean;
  stale_note: string | null;
}

interface Rechecked {
  checked: number;
  changed: { id: string; before: string; after: string }[];
}

const label = (r: Record<string, unknown>) =>
  r.status === "matched" ? String(asObject(r.register_entry).organisation_name) : String(r.status);

function withoutStored(r: Record<string, unknown>): Record<string, unknown> {
  const { schema_version: _v, id: _i, created_at: _c, updated_at: _u, ...rest } = r;
  return rest;
}

/** Download the register if it is due, then open the matcher over the copy in use. */
async function openSession(
  dataDir: string,
  w: StoreWriter,
): Promise<{ session: Session; refresh: Record<string, unknown> }> {
  const refresh = await refreshRegister(dataDir);
  const profile = await readProfile(dataDir);
  const key = profile?.companies_house_key;
  const session: Session = {
    index: buildIndex(await loadRegister(dataDir)),
    ch: typeof key === "string" && key !== "" ? new CompaniesHouse(key) : undefined,
    ...refresh.status,
  };
  const rechecked = refresh.refreshed ? await recheckEmployers(dataDir, w, session) : null;
  return {
    session,
    refresh: {
      refreshed: refresh.refreshed,
      csv_url: refresh.csv_url,
      organisations: refresh.organisations,
      rechecked,
    },
  };
}

/** After a register download: match every unpinned cached Employer again. */
async function recheckEmployers(dataDir: string, w: StoreWriter, s: Session): Promise<Rechecked> {
  const out: Rechecked = { checked: 0, changed: [] };
  for (const rec of await listRecords(dataDir, "employer")) {
    const agency = agencyOf(rec);
    if (rec.pinned || (agency !== undefined && agency.end_client === null)) continue;
    out.checked++;
    const town = typeof rec.town === "string" ? rec.town : undefined;
    let outcome = await matchName(
      s.index,
      s.ch,
      agency?.end_client ?? String(rec.brand_name),
      town,
      undefined,
    );
    if (outcome.status === "needs_judgment") {
      // Keep the earlier match while it is still one of the candidates. It goes through the
      // matcher again, so Companies House still has to verify it.
      const had = asObject(rec.register_entry);
      const prevKey = `${normaliseName(String(had.organisation_name ?? ""))}|${normaliseTown(String(had.town ?? ""))}`;
      if (outcome.candidates.some((c) => c.key === prevKey)) {
        outcome = await matchName(
          s.index,
          s.ch,
          agency?.end_client ?? String(rec.brand_name),
          town,
          { choice: prevKey },
        );
      }
    }
    const next = {
      ...rec,
      ...matchFields(outcome, false),
      matched_at: timestamp(),
      register_as_of: s.as_of,
    };
    await w.put("employer", rec.id, withoutStored(next));
    if (label(rec) !== label(next))
      out.changed.push({ id: rec.id, before: label(rec), after: label(next) });
  }
  return out;
}

const freshness = (s: Session) => ({ as_of: s.as_of, stale: s.stale, stale_note: s.stale_note });

function present(
  s: Session,
  employer: StoredRecord,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const pending = employer.status === "needs_judgment";
  return {
    employer,
    cached: false,
    ...freshness(s),
    companies_house:
      s.ch === undefined
        ? "not_set"
        : s.ch.unavailable !== null || s.ch.problem !== null
          ? "unavailable"
          : "used",
    judgment_needed: pending
      ? {
          question:
            "Which candidate, if any, is the same organisation as the Employer? Reply with its key, or null.",
          employer: employer.brand_name,
          town: employer.town,
          candidates: employer.candidates,
        }
      : null,
    ...extra,
  };
}

interface MatchInput {
  company: string;
  town?: string;
  description?: string;
  end_client?: string;
  judgment?: { choice: string | null };
}

function parseMatchInput(input: unknown): MatchInput {
  const o = asObject(input);
  const str = (k: string): string | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw usageError(`employer match: "${k}" must be a string`);
    return v.trim() === "" ? undefined : v.trim();
  };
  const company = str("company");
  if (company === undefined) throw usageError('employer match: "company" is required');
  const j = o.judgment;
  let judgment: MatchInput["judgment"];
  if (j !== undefined) {
    const choice = asObject(j).choice;
    if (choice !== null && typeof choice !== "string") {
      throw usageError('employer match: "judgment.choice" must be a candidate key or null');
    }
    judgment = { choice };
  }
  const parsed: MatchInput = { company };
  for (const k of ["town", "description", "end_client"] as const) {
    const v = str(k);
    if (v !== undefined) parsed[k] = v;
  }
  if (judgment !== undefined) parsed.judgment = judgment;
  return parsed;
}

/** Match one Listing's employer, or reuse the cached Employer. See the module comment. */
export async function matchEmployer(
  dataDir: string,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  const input = parseMatchInput(rawInput);
  return withWriter(dataDir, "employer match", async (w) => {
    const { session, refresh } = await openSession(dataDir, w);
    const id = employerId(input.company, input.town);
    const existing = await getRecord(dataDir, "employer", id);
    const endClient = input.end_client ?? agencyOf(existing)?.end_client ?? undefined;

    const reusable =
      existing !== undefined &&
      input.end_client === undefined &&
      input.judgment === undefined &&
      existing.status !== "needs_judgment" &&
      (existing.pinned !== undefined || existing.register_as_of === session.as_of);
    if (reusable) return present(session, existing, { cached: true, ...refresh });

    const known = agencyOf(existing)?.signals;
    const signals = known ?? (await detectAgency(session.ch, input.company, input.description));
    const isAgency = signals.length > 0 || endClient !== undefined;
    const agency: Agency = {
      detected: isAgency,
      signals:
        endClient !== undefined && signals.length === 0
          ? ["end client named by the job seeker"]
          : signals,
      end_client: endClient ?? null,
      badge: isAgency && endClient === undefined ? AGENCY_BADGE : null,
    };

    const base = {
      brand_name: input.company,
      town: input.town ?? null,
      matched_at: timestamp(),
      register_as_of: session.as_of,
      pinned: null,
      agency,
      mail_domains: existing?.mail_domains ?? [],
      application_limit_notes: existing?.application_limit_notes ?? [],
    };
    let fields: Record<string, unknown>;
    if (isAgency && endClient === undefined) {
      fields = {
        status: "agency",
        register_entry: null,
        company_number: null,
        verified_by_companies_house: false,
        match_tier: null,
        confidence: null,
        unmatched_reason:
          "Agency listing: the end client isn't named, so the sponsor can't be checked.",
        candidates: [],
      };
    } else {
      const outcome = await matchName(
        session.index,
        session.ch,
        endClient ?? input.company,
        input.town,
        input.judgment,
      );
      fields = matchFields(outcome, false);
    }
    const employer = await w.put("employer", id, { ...base, ...fields });
    return present(session, employer, refresh);
  });
}

/** `sponsor refresh`: download the register if due and re-check cached Employers. */
export async function sponsorRefresh(dataDir: string): Promise<Record<string, unknown>> {
  return withWriter(dataDir, "sponsor refresh", async (w) => {
    const { session, refresh } = await openSession(dataDir, w);
    return { ...refresh, ...freshness(session) };
  });
}

export async function sponsorStatus(dataDir: string): Promise<Record<string, unknown>> {
  return { ...registerStatus(await readRegisterMeta(dataDir)) };
}

/** Confirm the current match: pin it so later register downloads keep it. */
export async function confirmEmployer(
  dataDir: string,
  id: string,
): Promise<Record<string, unknown>> {
  return withWriter(dataDir, "employer confirm", async (w) => {
    const rec = await getRecord(dataDir, "employer", id);
    if (rec === undefined) throw notFound("employer", id);
    if (rec.status !== "matched") {
      throw new CoreError(
        "NOTHING_TO_CONFIRM",
        "This Employer has no match to confirm. Correct it instead.",
      );
    }
    const employer = await w.put("employer", id, {
      ...withoutStored(rec),
      pinned: { at: timestamp(), action: "confirmed" },
    });
    return { employer };
  });
}

/** Correct the match to a named register entry (or to none) and pin the correction. */
export async function correctEmployer(
  dataDir: string,
  id: string,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  const o = asObject(rawInput);
  const none = o.none === true;
  if (!none && typeof o.organisation_name !== "string") {
    throw usageError('employer correct: give {"organisation_name", "town"?} or {"none": true}');
  }
  return withWriter(dataDir, "employer correct", async (w) => {
    const rec = await getRecord(dataDir, "employer", id);
    if (rec === undefined) throw notFound("employer", id);
    let fields: Record<string, unknown>;
    if (none) {
      fields = matchFields(
        { status: "unmatched", reason: "Corrected by the job seeker: not on the register." },
        false,
      );
    } else {
      const wanted = normaliseName(String(o.organisation_name));
      const town = typeof o.town === "string" ? o.town : undefined;
      const hits = (await loadRegister(dataDir)).filter(
        (g) => g.names.includes(wanted) && (town === undefined || townsAgree(g.town, town)),
      );
      if (hits.length !== 1) {
        throw new CoreError(
          "NOT_ON_REGISTER",
          hits.length === 0
            ? "That organisation isn't on the register copy. Check the name and town."
            : "More than one register entry has that name. Give the town too.",
        );
      }
      fields = {
        ...matchFields(
          {
            status: "matched",
            tier: "exact",
            group: hits[0] as RegisterGroup,
            company_number: null,
          },
          false,
        ),
        match_tier: "corrected",
      };
    }
    const employer = await w.put("employer", id, {
      ...withoutStored(rec),
      ...fields,
      matched_at: timestamp(),
      pinned: { at: timestamp(), action: "corrected" },
    });
    return { employer };
  });
}

/** The job seeker names an agency Listing's end client; match runs again for it. */
export async function nameEndClient(
  dataDir: string,
  id: string,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  const endClient = asObject(rawInput).end_client;
  if (typeof endClient !== "string" || endClient.trim() === "") {
    throw usageError('employer end-client: give {"end_client": "<name>"}');
  }
  const rec = await getRecord(dataDir, "employer", id);
  if (rec === undefined) throw notFound("employer", id);
  return matchEmployer(dataDir, {
    company: rec.brand_name,
    ...(typeof rec.town === "string" ? { town: rec.town } : {}),
    end_client: endClient,
  });
}
