// Screen steps 1 and 2 (#39): the scam gate and the deny list. Both are hard exclusions:
// a failed Check with effect "exclude" takes the Listing off the Shortlist and cuts the later
// Checks off ("not reached"). Deterministic text rules only; the core never calls a model.
//
//  - scam.signs       FTC and FBI signs of a job scam stated in the advert: payment by the
//                     applicant, cryptocurrency, reshipping, interviews by text chat only.
//  - scam.no_vacancy  the employer's own "no current vacancy" statement, wherever it appears.
//  - deny.list        the Profile's `filters.deny` companies, titles and locations.
// See docs/agents/core-conventions.md, "Screen exclusions and ghost score".
import { normaliseCompanyName } from "./same-role.ts";
import type { Check, CheckSpec, ScreenStep, StepContext } from "./screen-check.ts";
import { isObject } from "./validate.ts";

/** Each sign is a name shown to the job seeker and the patterns that state it. */
export const SCAM_SIGNS: { sign: string; source: string; patterns: RegExp[] }[] = [
  {
    sign: "payment",
    source: "FTC: anyone who asks you to pay to get a job is a scammer",
    patterns: [
      /\b(training|registration|application|processing|onboarding|equipment|starter[- ]kit|background[- ]check|certification) fees?\b/i,
      /\b(purchase|buy|pay for) your own (starter kit|equipment|laptop|software|training|supplies|uniform)/i,
      /\b(must|need to|required to|will be asked to) (pay|purchase|buy) \S+/i,
      /\b(deposit|cash) (the|a|this) (check|cheque)\b/i,
      /\bwire (the )?(money|funds|transfer)\b/i,
      /\bgift cards?\b/i,
      /\b(refundable|upfront|advance) (deposit|payment|fee)s?\b/i,
    ],
  },
  {
    sign: "crypto",
    source: "FBI IC3: employers who pay in, or ask you to send, cryptocurrency",
    patterns: [
      /\b(paid|pay|payment|salary|compensation|wages?)\b[^.]{0,30}\b(in|via|with|by)\s+(bitcoin|btc|usdt|usdc|ethereum|crypto\w*)/i,
      /\b(deposit|send|transfer|buy|purchase|invest)\w*\s+(\w+\s+){0,2}(bitcoin|btc|usdt|usdc|ethereum|crypto\w*)\b/i,
      /\b(optimi[sz]ation|rating|review) tasks?\b/i,
    ],
  },
  {
    sign: "reshipping",
    source: "FTC: reshipping and package forwarding are a mule scam",
    patterns: [
      /\bre-?ship(ping)?\b/i,
      /\bpackage[- ]forwarding\b/i,
      /\b(receive|forward|repackage|reship)\s+(packages|parcels|shipments)\b/i,
    ],
  },
  {
    sign: "text_only_interview",
    source: "FTC: interviews by text or chat app only",
    patterns: [
      /\b(text|chat)[- ]only interviews?\b/i,
      /\binterviews?\b[^.]{0,60}\b(telegram|whatsapp|signal|text messag\w*|chat only)\b/i,
      /\b(telegram|whatsapp|signal)\b[^.]{0,60}\binterviews?\b/i,
    ],
  },
];

const NO_VACANCY: RegExp[] = [
  /\bno (current |existing |open )?(vacanc(y|ies)|openings?)\b/i,
  /\bnot (currently )?(for|an?) (an? )?(existing|current|actual|open) (vacancy|job|opening|position)\b/i,
  /\bnot (currently )?hiring for this (role|position|job)\b/i,
  /\bcollecting (resumes|resumés|cvs?)\b/i,
];

export const SCAM_SPECS: CheckSpec[] = [
  {
    check: "scam.signs",
    name: "Scam signs",
    rule: "No payment, crypto, reshipping or text-only interview (FTC, FBI)",
  },
  {
    check: "scam.no_vacancy",
    name: "No-vacancy statement",
    rule: "The employer does not say there is no current vacancy",
  },
];

/** The text a quote is cut from, cut to the match and a little around it. */
function quote(text: string, m: RegExpMatchArray): string {
  const at = m.index ?? 0;
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + m[0].length + 30);
  return `"${text.slice(start, end).replace(/\s+/g, " ").trim()}"`;
}

function advertText(ctx: StepContext): string {
  return `${ctx.listing.title}\n${ctx.listing.description ?? ""}`;
}

function verdict(spec: CheckSpec, hits: string[], citation: string, clear: string): Check {
  const failed = hits.length > 0;
  return {
    ...spec,
    result: failed ? "excluded" : "pass",
    status: failed ? "fail" : "pass",
    effect: failed ? "exclude" : null,
    citation: failed ? citation : clear,
    evidence: failed ? hits : [],
    label: null,
  };
}

export const scamStep: ScreenStep = {
  id: "scam",
  checks: SCAM_SPECS,
  run(ctx) {
    const text = advertText(ctx);
    const signs: string[] = [];
    const sources: string[] = [];
    for (const { sign, source, patterns } of SCAM_SIGNS) {
      for (const p of patterns) {
        const m = text.match(p);
        if (m) {
          signs.push(`${sign}: ${quote(text, m)}`);
          sources.push(source);
          break;
        }
      }
    }
    const vacancy: string[] = [];
    for (const p of NO_VACANCY) {
      const m = text.match(p);
      if (m) vacancy.push(`employer statement: ${quote(text, m)}`);
    }
    const [signsSpec, vacancySpec] = SCAM_SPECS as [CheckSpec, CheckSpec];
    return {
      checks: [
        verdict(signsSpec, signs, [...new Set(sources)].join("; "), "no scam signs in the advert"),
        verdict(
          vacancySpec,
          vacancy.slice(0, 1),
          "The employer's own statement that there is no current vacancy",
          "no no-vacancy statement in the advert",
        ),
      ],
    };
  },
};

// ---------------------------------------------------------------------------------------
// Deny list

export const DENY_SPEC: CheckSpec = {
  check: "deny.list",
  name: "Deny list",
  rule: "Company, title and location are not on your Profile's deny list",
};

function denied(profile: Record<string, unknown>, side: string): string[] {
  const filters = isObject(profile.filters) ? profile.filters : {};
  const deny = isObject(filters.deny) ? filters.deny : {};
  const v = deny[side];
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
}

export const denyStep: ScreenStep = {
  id: "deny",
  checks: [DENY_SPEC],
  run(ctx) {
    const company = normaliseCompanyName(String(ctx.listing.company ?? ""));
    const title = String(ctx.listing.title ?? "").toLowerCase();
    const location = String(ctx.listing.location ?? "").toLowerCase();
    const hits: string[] = [];
    for (const e of denied(ctx.profile, "companies")) {
      if (normaliseCompanyName(e) === company) {
        hits.push(
          `company "${ctx.listing.company}" is on your deny list (filters.deny.companies: ${e})`,
        );
      }
    }
    for (const e of denied(ctx.profile, "titles")) {
      if (title.includes(e.toLowerCase())) {
        hits.push(`title "${ctx.listing.title}" contains "${e}" (filters.deny.titles)`);
      }
    }
    for (const e of denied(ctx.profile, "locations")) {
      if (location !== "" && location.includes(e.toLowerCase())) {
        hits.push(`location "${ctx.listing.location}" contains "${e}" (filters.deny.locations)`);
      }
    }
    const failed = hits.length > 0;
    return {
      checks: [
        {
          ...DENY_SPEC,
          result: failed ? "denied" : "pass",
          status: failed ? "fail" : "pass",
          effect: failed ? "exclude" : null,
          citation: failed
            ? "Your deny list; it changes only when you edit your Profile"
            : "not on your deny list",
          evidence: hits,
          label: null,
        },
      ],
    };
  },
};
