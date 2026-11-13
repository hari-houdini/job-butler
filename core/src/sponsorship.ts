// UK Sponsorship verdict (#41): a Screen step that gives each Listing likely, failed or unknown.
//
// The rules sit behind a regime-neutral interface (SponsorshipRegime): employer evidence, role
// and wage evidence, and a wording lexicon. Only the UK Skilled Worker rules ship
// (sponsorship-uk.ts). This file holds the interface, the verdict combiner and the step.
//
//   likely  = employer, role and pay all pass and no negative wording
//   failed  = negative wording (overrides everything), or any check fails
//   unknown = anything else: missing evidence is never a yes
import { CoreError } from "./errors.ts";
import { type Check, type CheckSpec, notReached, type ScreenStep } from "./screen-check.ts";
import { normaliseName, townsAgree } from "./sponsor.ts";
import {
  readTables,
  refreshTables,
  tablesStatus,
  tablesUnavailable,
  ukRegime,
} from "./sponsorship-uk.ts";
import { listRecords, type StoredRecord, withEditLock } from "./store.ts";
import { isObject } from "./validate.ts";

export interface Evidence {
  status: "ok" | "fail" | "unknown";
  /** Short result shown on the node, e.g. "A-rated Skilled Worker sponsor". */
  result: string;
  /** The threshold or rule, one line. */
  rule: string;
  /** One-line source and date. */
  citation: string;
  evidence: string[];
}

export interface RoleEvidence {
  role: Evidence;
  pay: Evidence;
  /** Fields kept on `screen.sponsorship` (codes, salary, required pay, discount used). */
  stored: Record<string, unknown>;
}

export interface WordingLexicon {
  /** Override everything: the employer says it will not sponsor. */
  negative: RegExp[];
  /** Mildly negative boilerplate; noted, never a refusal. */
  weak: RegExp[];
  positive: RegExp[];
}

export interface DataStatus {
  as_of: string | null;
  stale: boolean;
  stale_note: string | null;
}

export interface SponsorshipRegime<Data> {
  id: string;
  name: string;
  /** `employer` is the Employer record matched for the Listing (#40), if any. */
  employerEvidence(listing: StoredRecord, employer: StoredRecord | undefined): Evidence;
  /** `sponsorship` is the Profile's Sponsorship section (derived flags only). */
  roleEvidence(listing: StoredRecord, sponsorship: unknown, data: Data): RoleEvidence;
  wordingLexicon: WordingLexicon;
  dataStatus(data: Data): DataStatus;
}

/** Regimes by ID. Add another regime here; the step and the verdict don't change. */
// biome-ignore lint/suspicious/noExplicitAny: each regime types its own data
const REGIMES: Record<string, SponsorshipRegime<any>> = { [ukRegime.id]: ukRegime };
const DEFAULT_REGIME = ukRegime.id;

/** What `screen record` loads once per batch for the step (StepContext.sponsorship). */
export interface SponsorshipContext {
  employers: StoredRecord[];
  data: unknown;
}

export async function loadSponsorshipContext(
  dataDir: string,
  profile: Record<string, unknown>,
): Promise<SponsorshipContext | undefined> {
  if (!isObject(profile.sponsorship) || profile.sponsorship.needed !== true) return undefined;
  await refreshTables(dataDir); // weekly; a failure keeps the last copy and marks it stale
  return { employers: await listRecords(dataDir, "employer"), data: await readTables(dataDir) };
}

/** `sponsorship refresh`: download the GOV.UK tables when a week old and report freshness. */
export async function sponsorshipRefresh(dataDir: string): Promise<Record<string, unknown>> {
  return withEditLock(dataDir, "sponsorship refresh", "the Sponsorship tables", async () => {
    const { refreshed } = await refreshTables(dataDir);
    const tables = await readTables(dataDir);
    if (tables === null) throw tablesUnavailable();
    return {
      refreshed,
      ...tablesStatus(tables),
      occupations: tables.occupations.length,
      going_rates: tables.going_rates.length,
      occupation_url: tables.occupation_url,
      going_rate_url: tables.going_rate_url,
    };
  });
}

// --- the Employer record for a Listing ----------------------------------------------------

/** The cached Employer for the Listing's company: same normalised brand, town breaking ties. */
function employerFor(listing: StoredRecord, employers: StoredRecord[]): StoredRecord | undefined {
  const brand = normaliseName(String(listing.company ?? ""));
  const same = employers.filter((e) => normaliseName(String(e.brand_name ?? "")) === brand);
  if (same.length <= 1) return same[0];
  const place = typeof listing.location === "string" ? listing.location : "";
  return (
    same.find((e) => typeof e.town === "string" && townsAgree(e.town, place)) ??
    same.find((e) => e.town === null)
  );
}

// --- wording -------------------------------------------------------------------------------

function wordingEvidence(listing: StoredRecord, lex: WordingLexicon) {
  const text = `${listing.title ?? ""}\n${listing.description ?? ""}`;
  const quotes = (res: RegExp[]) =>
    res.flatMap((re) => {
      const m = re.exec(text);
      return m === null ? [] : [m[0].replace(/\s+/g, " ")];
    });
  return {
    negative: quotes(lex.negative),
    weak: quotes(lex.weak),
    positive: quotes(lex.positive),
  };
}

// --- the step -------------------------------------------------------------------------------

export const SPONSORSHIP_SPECS: CheckSpec[] = [
  {
    check: "sponsorship.employer",
    name: "Sponsorship employer",
    rule: "A-rated Skilled Worker entry on the Home Office register",
  },
  {
    check: "sponsorship.role",
    name: "Sponsorship role",
    rule: "SOC 2020 code on the Higher Skilled list",
  },
  {
    check: "sponsorship.pay",
    name: "Sponsorship pay",
    rule: "At least the higher of £41,700 and the going rate, less any discount",
  },
  {
    check: "sponsorship.wording",
    name: "Sponsorship wording",
    rule: "No negative wording such as 'unable to sponsor'; it overrides every check",
  },
  {
    check: "sponsorship.verdict",
    name: "Sponsorship",
    rule: "Likely only when employer, role and pay all pass; missing evidence is unknown",
  },
];

const STATUS = { ok: "pass", fail: "fail", unknown: "warn" } as const;

function fromEvidence(spec: CheckSpec, e: Evidence): Check {
  return {
    ...spec,
    rule: e.rule,
    result: e.result,
    status: STATUS[e.status],
    effect: null,
    citation: e.citation,
    evidence: e.evidence,
    label: null,
  };
}

function skipped(spec: CheckSpec): Check {
  return {
    ...notReached(spec),
    result: "not a criterion",
    status: "pass",
    citation: "Sponsorship is not a criterion in the Profile",
  };
}

export const sponsorshipStep: ScreenStep = {
  id: "sponsorship",
  checks: SPONSORSHIP_SPECS,
  run({ listing, profile, sponsorship: shared }) {
    const section = isObject(profile.sponsorship) ? profile.sponsorship : {};
    const [employerSpec, roleSpec, paySpec, wordingSpec, verdictSpec] = SPONSORSHIP_SPECS as [
      CheckSpec,
      CheckSpec,
      CheckSpec,
      CheckSpec,
      CheckSpec,
    ];
    if (section.needed !== true || shared === undefined) {
      return { checks: SPONSORSHIP_SPECS.map(skipped) };
    }
    const id = typeof section.regime === "string" ? section.regime : DEFAULT_REGIME;
    const regime = REGIMES[id];
    if (regime === undefined) {
      throw new CoreError("UNKNOWN_REGIME", `There are no Sponsorship rules for "${id}".`);
    }

    const employer = employerFor(listing, shared.employers);
    const employerEv = regime.employerEvidence(listing, employer);
    const { role, pay, stored } = regime.roleEvidence(listing, section, shared.data);
    const words = wordingEvidence(listing, regime.wordingLexicon);
    const wording: Evidence =
      words.negative.length > 0
        ? {
            status: "fail",
            result: `negative wording: "${words.negative[0]}"`,
            rule: wordingSpec.rule,
            citation: `Listing text, ${regime.name} wording lexicon`,
            evidence: words.negative.map((q) => `says: "${q}"`),
          }
        : {
            status: "ok",
            result: "no negative wording",
            rule: wordingSpec.rule,
            citation: `Listing text, ${regime.name} wording lexicon`,
            evidence: [
              ...words.weak.map((q) => `mildly negative, not a refusal: "${q}"`),
              ...words.positive.map((q) => `positive: "${q}"`),
            ],
          };

    const parts = [employerEv, role, pay];
    const verdict =
      words.negative.length > 0 || parts.some((p) => p.status === "fail")
        ? "failed"
        : parts.every((p) => p.status === "ok")
          ? "likely"
          : "unknown";
    const agency = isObject(employer?.agency) ? employer.agency.badge : null;
    const label =
      verdict === "failed"
        ? "Sponsorship: failed"
        : verdict === "unknown"
          ? `Sponsorship: unknown${typeof agency === "string" ? ` · ${agency}` : ""}`
          : null;
    const reasons = [
      ...(words.negative.length > 0
        ? [`negative wording "${words.negative[0]}" overrides the checks`]
        : []),
      ...[
        ["employer", employerEv],
        ["role", role],
        ["pay", pay],
      ]
        .filter(([, e]) => (e as Evidence).status !== "ok")
        .map(([n, e]) => `${n}: ${(e as Evidence).result}`),
    ];
    const verdictCheck: Check = {
      ...verdictSpec,
      result: verdict,
      status: verdict === "failed" ? "fail" : verdict === "unknown" ? "warn" : "pass",
      effect: verdict === "failed" ? "flag" : verdict === "unknown" ? "badge" : null,
      citation: `${regime.name}: all three checks must pass; negative wording overrides`,
      evidence: reasons.length > 0 ? reasons : ["employer, role and pay all pass"],
      label,
    };
    const data = regime.dataStatus(shared.data);
    return {
      checks: [
        fromEvidence(employerSpec, employerEv),
        fromEvidence(roleSpec, role),
        fromEvidence(paySpec, pay),
        fromEvidence(wordingSpec, wording),
        verdictCheck,
      ],
      stored: {
        sponsorship: {
          regime: regime.id,
          verdict,
          confidence: verdict === "likely" ? (words.positive.length > 0 ? "high" : "medium") : null,
          employer_id: employer?.id ?? null,
          wording: words,
          tables_as_of: data.as_of,
          tables_stale: data.stale,
          ...stored,
        },
      },
    };
  },
};
