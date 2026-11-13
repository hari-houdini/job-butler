// Fit score (Screen step 5): how well a Listing matches the Profile, 0–100 with bands.
//
//  - Rules (deterministic): location, seniority and target roles, each pass, unknown or fail.
//  - The skills rating: the screen worker's LLM judgment of the advert's criteria against the
//    Base resume, with a quote from the advert and evidence from the resume per criterion.
//  - Score = SKILLS_WEIGHT × skills + RULES_WEIGHT × rules, rounded. A failed rule caps the
//    score in the weak band (WEAK_CAP). The weights are fixed in v1.
// Fit ranks the Shortlist and never removes a Listing. See core-conventions.md, "Screen".
import type { Check, CheckSpec, CheckStatus, ScreenStep } from "./screen-check.ts";
import { isObject, type Problems } from "./validate.ts";

export const SKILLS_WEIGHT = 0.8;
export const RULES_WEIGHT = 0.2;
/** A failed rule caps the score here: the top of the weak band. */
export const WEAK_CAP = 49;
const IMPORTANCE_WEIGHT = { core: 2, nice: 1 } as const;
const MATCH_VALUE = { strong: 1, partial: 0.5, none: 0 } as const;
const RULE_VALUE = { pass: 1, unknown: 0.5, fail: 0 } as const;

export type Band = "strong" | "partial" | "weak";
export type RuleResult = keyof typeof RULE_VALUE;
export type RuleName = "location" | "seniority" | "target_roles";

export function band(score: number): Band {
  if (score >= 80) return "strong";
  if (score >= 50) return "partial";
  return "weak";
}

export interface FitRule {
  rule: RuleName;
  result: RuleResult;
  evidence: string;
}

export interface Criterion {
  criterion: string;
  importance: keyof typeof IMPORTANCE_WEIGHT;
  match: keyof typeof MATCH_VALUE;
  listing_quote: string;
  resume_evidence: string | null;
}

export interface SkillsRating {
  summary: string;
  criteria: Criterion[];
}

/** What Screen stores as `screen.fit` on the Listing. */
export interface FitBreakdown {
  score: number;
  band: Band;
  skills_score: number;
  rules_score: number;
  capped: boolean;
  weights: { skills: number; rules: number };
  rules: FitRule[];
  summary: string;
  criteria: Criterion[];
}

export interface FitTargets {
  roles: string[];
  seniority: string[];
  locations: string[];
  remote: boolean;
  deny_locations: string[];
  allow_locations: string[];
}

/** The parts of the Profile the Fit rules read. */
export function fitTargets(profile: Record<string, unknown>): FitTargets {
  const targets = isObject(profile.targets) ? profile.targets : {};
  const filters = isObject(profile.filters) ? profile.filters : {};
  const side = (s: string, k: string): string[] => {
    const v = filters[s];
    return isObject(v) && Array.isArray(v[k]) ? (v[k] as string[]) : [];
  };
  const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
  return {
    roles: strings(targets.roles),
    seniority: strings(targets.seniority),
    locations: strings(targets.locations),
    remote: targets.remote === true,
    deny_locations: side("deny", "locations"),
    allow_locations: side("allow", "locations"),
  };
}

// ---- the skills rating: validation ----

/** Check one Listing's `skills_rating` from the screen worker; push plain-words problems. */
export function checkSkillsRating(v: unknown, path: string, p: Problems): void {
  if (!isObject(v)) {
    p.push(`${path} must be an object with "summary" and "criteria"`);
    return;
  }
  if (typeof v.summary !== "string" || v.summary.trim() === "") {
    p.push(`${path}.summary must be one non-empty sentence`);
  }
  if (!Array.isArray(v.criteria) || v.criteria.length === 0) {
    p.push(`${path}.criteria must be a non-empty list`);
    return;
  }
  v.criteria.forEach((c, i) => {
    const at = `${path}.criteria[${i}]`;
    if (!isObject(c)) {
      p.push(`${at} must be an object`);
      return;
    }
    const allowed = ["criterion", "importance", "match", "listing_quote", "resume_evidence"];
    for (const k of Object.keys(c)) if (!allowed.includes(k)) p.push(`${at}.${k} is not expected`);
    if (typeof c.criterion !== "string" || c.criterion.trim() === "") {
      p.push(`${at}.criterion must name the requirement`);
    }
    if (!(typeof c.importance === "string" && c.importance in IMPORTANCE_WEIGHT)) {
      p.push(`${at}.importance must be "core" or "nice"`);
    }
    if (!(typeof c.match === "string" && c.match in MATCH_VALUE)) {
      p.push(`${at}.match must be "strong", "partial" or "none"`);
    }
    if (typeof c.listing_quote !== "string" || c.listing_quote.trim() === "") {
      p.push(`${at}.listing_quote must quote the advert`);
    }
    const evidence = c.resume_evidence;
    if (c.match !== "none" && (typeof evidence !== "string" || evidence.trim() === "")) {
      p.push(`${at}.resume_evidence must cite the Base resume fact behind a ${c.match} match`);
    } else if (evidence !== null && evidence !== undefined && typeof evidence !== "string") {
      p.push(`${at}.resume_evidence must be text or null`);
    }
  });
}

// ---- rules ----

const SENIORITY_WORDS: Record<string, string> = {
  intern: "intern",
  internship: "intern",
  junior: "junior",
  jr: "junior",
  graduate: "junior",
  entry: "junior",
  senior: "senior",
  sr: "senior",
  staff: "staff",
  principal: "principal",
  lead: "lead",
  manager: "manager",
  head: "manager",
  director: "director",
  vp: "director",
  chief: "executive",
  cto: "executive",
};

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/back[\s-]end/g, "backend")
    .replace(/front[\s-]end/g, "frontend")
    .replace(/full[\s-]stack/g, "fullstack")
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((w) => w !== "");
}

const quoted = (s: string) => JSON.stringify(s);
const listed = (xs: string[]) => xs.join(", ");

function includesPlace(location: string, place: string): boolean {
  return location.toLowerCase().includes(place.toLowerCase());
}

function locationRule(location: string | null, t: FitTargets): FitRule {
  const rule = "location" as const;
  if (location === null || location.trim() === "") {
    return { rule, result: "unknown", evidence: "The Listing states no location." };
  }
  const denied = t.deny_locations.find((d) => includesPlace(location, d));
  if (denied !== undefined) {
    return { rule, result: "fail", evidence: `${quoted(location)} is on your location deny list.` };
  }
  const place = [...t.locations, ...t.allow_locations].find((l) => includesPlace(location, l));
  if (place !== undefined) {
    return {
      rule,
      result: "pass",
      evidence: `${quoted(location)} matches your location ${place}.`,
    };
  }
  if (t.remote && /\b(remote|anywhere)\b/i.test(location)) {
    return { rule, result: "pass", evidence: `${quoted(location)} is remote, which you accept.` };
  }
  const yours = t.locations.length > 0 ? listed(t.locations) : "none set";
  return {
    rule,
    result: "fail",
    evidence: `${quoted(location)} isn't one of your locations (${yours})${t.remote ? " and isn't remote" : ""}.`,
  };
}

function seniorityRule(title: string, t: FitTargets): FitRule {
  const rule = "seniority" as const;
  const found = words(title).filter((w) => w in SENIORITY_WORDS);
  if (found.length === 0) {
    return { rule, result: "unknown", evidence: `The title ${quoted(title)} names no seniority.` };
  }
  if (t.seniority.length === 0) {
    return { rule, result: "pass", evidence: "Your Profile targets no particular seniority." };
  }
  const levels = found.map((w) => SENIORITY_WORDS[w] as string);
  const hit = found.find((w) => t.seniority.includes(SENIORITY_WORDS[w] as string));
  if (hit !== undefined) {
    return {
      rule,
      result: "pass",
      evidence: `${quoted(hit)} in the title is a seniority you target (${listed(t.seniority)}).`,
    };
  }
  return {
    rule,
    result: "fail",
    evidence: `The title is ${listed([...new Set(levels)])}, not a seniority you target (${listed(t.seniority)}).`,
  };
}

function targetRolesRule(title: string, t: FitTargets): FitRule {
  const rule = "target_roles" as const;
  if (t.roles.length === 0) {
    return { rule, result: "pass", evidence: "Your Profile names no target roles." };
  }
  const titleWords = new Set(words(title));
  const role = t.roles.find((r) =>
    words(r)
      .filter((w) => !(w in SENIORITY_WORDS))
      .every((w) => titleWords.has(w)),
  );
  if (role !== undefined) {
    return {
      rule,
      result: "pass",
      evidence: `The title matches your target role ${quoted(role)}.`,
    };
  }
  return {
    rule,
    result: "fail",
    evidence: `The title ${quoted(title)} matches none of your target roles (${listed(t.roles)}).`,
  };
}

// ---- the score ----

const round1 = (n: number) => Math.round(n * 10) / 10;

export function fitBreakdown(
  listing: { title: string; location: string | null },
  targets: FitTargets,
  rating: SkillsRating,
): FitBreakdown {
  const rules = [
    locationRule(listing.location, targets),
    seniorityRule(listing.title, targets),
    targetRolesRule(listing.title, targets),
  ];
  let weight = 0;
  let got = 0;
  for (const c of rating.criteria) {
    weight += IMPORTANCE_WEIGHT[c.importance];
    got += IMPORTANCE_WEIGHT[c.importance] * MATCH_VALUE[c.match];
  }
  const skills = (got / weight) * 100;
  const rulesScore = (rules.reduce((s, r) => s + RULE_VALUE[r.result], 0) / rules.length) * 100;
  const raw = Math.round(SKILLS_WEIGHT * skills + RULES_WEIGHT * rulesScore);
  const failed = rules.some((r) => r.result === "fail");
  const score = failed ? Math.min(raw, WEAK_CAP) : raw;
  return {
    score,
    band: band(score),
    skills_score: round1(skills),
    rules_score: round1(rulesScore),
    capped: failed && raw > WEAK_CAP,
    weights: { skills: SKILLS_WEIGHT, rules: RULES_WEIGHT },
    rules,
    summary: rating.summary,
    criteria: rating.criteria.map((c) => ({
      criterion: c.criterion,
      importance: c.importance,
      match: c.match,
      listing_quote: c.listing_quote,
      resume_evidence: c.resume_evidence ?? null,
    })),
  };
}

// ---- the Screen step ----

const RULE_SPECS: Record<RuleName, CheckSpec> = {
  location: {
    check: "fit.location",
    name: "Location",
    rule: "In your locations, or remote when you accept remote; not on your location deny list",
  },
  seniority: {
    check: "fit.seniority",
    name: "Seniority",
    rule: "The seniority the title names is one you target",
  },
  target_roles: {
    check: "fit.target_roles",
    name: "Target roles",
    rule: "The title has every word of one of your target roles",
  },
};
const SKILLS_SPEC: CheckSpec = {
  check: "fit.skills",
  name: "Skills rating",
  rule: "Advert criteria against your Base resume: core counts double; strong 1, partial ½, none 0",
};
const SCORE_SPEC: CheckSpec = {
  check: "fit.score",
  name: "Fit score",
  rule:
    `0–100 = ${SKILLS_WEIGHT * 100}% skills + ${RULES_WEIGHT * 100}% rules; a failed rule caps ` +
    `it at ${WEAK_CAP} · 80+ strong · 50–79 partial · <50 weak`,
};

const RULE_STATUS: Record<RuleResult, CheckStatus> = {
  pass: "pass",
  unknown: "warn",
  fail: "fail",
};
const BAND_STATUS: Record<Band, CheckStatus> = { strong: "pass", partial: "warn", weak: "fail" };
const MATCH_MARK = { strong: "✓", partial: "~", none: "✗" } as const;

/** Screen step 5: the Fit score. Ranking only: none of its Checks excludes or flags. */
export const fitStep: ScreenStep = {
  id: "fit",
  checks: [
    RULE_SPECS.location,
    RULE_SPECS.seniority,
    RULE_SPECS.target_roles,
    SKILLS_SPEC,
    SCORE_SPEC,
  ],
  judgment: { key: "skills_rating", check: checkSkillsRating },
  run({ listing, profile, judgment }) {
    const fit = fitBreakdown(
      { title: String(listing.title), location: (listing.location as string | null) ?? null },
      fitTargets(profile),
      judgment as SkillsRating,
    );
    const ruleChecks: Check[] = fit.rules.map((r) => ({
      ...RULE_SPECS[r.rule],
      result: r.result,
      status: RULE_STATUS[r.result],
      effect: null,
      citation: r.evidence,
      evidence: [r.evidence],
      label: null,
    }));
    const skills = Math.round(fit.skills_score);
    const strong = fit.criteria.filter((c) => c.match === "strong").length;
    const skillsCheck: Check = {
      ...SKILLS_SPEC,
      result: `${skills}/100`,
      status: BAND_STATUS[band(skills)],
      effect: null,
      citation: `${strong} of ${fit.criteria.length} criteria strongly evidenced. ${fit.summary}`,
      evidence: fit.criteria.map(
        (c) =>
          `${MATCH_MARK[c.match]} ${c.criterion} (${c.importance}, ${c.match}): ` +
          `${JSON.stringify(c.listing_quote)}${c.resume_evidence ? ` ← ${c.resume_evidence}` : ""}`,
      ),
      label: null,
    };
    const failed = fit.rules.filter((r) => r.result === "fail").map((r) => RULE_SPECS[r.rule].name);
    const sum = `${fit.weights.skills} × ${fit.skills_score} + ${fit.weights.rules} × ${fit.rules_score}`;
    const uncapped = Math.round(SKILLS_WEIGHT * fit.skills_score + RULES_WEIGHT * fit.rules_score);
    const scoreCheck: Check = {
      ...SCORE_SPEC,
      result: `${fit.score} ${fit.band}`,
      status: BAND_STATUS[fit.band],
      effect: null,
      citation: fit.capped
        ? `${sum} ≈ ${uncapped}, capped at ${WEAK_CAP}: ${failed.join(", ").toLowerCase()} failed`
        : `${sum} ≈ ${fit.score}`,
      evidence: [
        `${sum} ≈ ${uncapped} before any cap`,
        ...(failed.length > 0 ? [`Failed rules: ${failed.join(", ")} (cap ${WEAK_CAP})`] : []),
      ],
      label: null,
    };
    return { checks: [...ruleChecks, skillsCheck, scoreCheck], stored: { fit } };
  },
};
