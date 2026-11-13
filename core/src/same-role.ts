// "Same role at the same company": the deterministic half of a judgment shared by Discover's
// dedupe (#37) and Screen's Application limits (#42, reapply cooldown on the same role).
// These functions only find candidates; the LLM confirms them (the worker's "same job?"
// judgment for dedupe). Scope is the Employer when both sides have one, else the normalised
// company name. See docs/agents/core-conventions.md, "Same role".

/** Legal and filler suffixes dropped from company names (sponsor-register matching list). */
const COMPANY_SUFFIXES = new Set([
  "ltd",
  "limited",
  "plc",
  "llp",
  "uk",
  "group",
  "inc",
  "incorporated",
  "llc",
  "co",
  "company",
  "corp",
  "corporation",
  "gmbh",
]);

/** Lowercase, "&" as "and", punctuation removed, whitespace collapsed. */
function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");
}

/** "Acme (UK) Ltd." → "acme"; "The Amazon" → "the amazon". Trailing legal suffixes only. */
export function normaliseCompanyName(name: string): string {
  const w = words(name);
  while (w.length > 1 && COMPANY_SUFFIXES.has(w[w.length - 1] as string)) w.pop();
  return w.join(" ");
}

/** "Senior Software Engineer " → "senior software engineer". */
export function normaliseTitle(title: string): string {
  return words(title).join(" ");
}

/** "London, United Kingdom" → "london united kingdom"; no location → "". */
export function normaliseLocation(location: string | null | undefined): string {
  return location == null ? "" : words(location).join(" ");
}

/** What the same-role check reads from a Listing (or an Application's role). */
export interface RoleRef {
  company: string;
  /** The Employer ID, once Screen has matched one (#40); absent or null before. */
  employer?: string | null;
  title: string;
  location?: string | null;
}

/** Same Employer when both have one; otherwise the same normalised company name. */
export function sameCompany(a: RoleRef, b: RoleRef): boolean {
  if (typeof a.employer === "string" && typeof b.employer === "string") {
    return a.employer === b.employer;
  }
  return normaliseCompanyName(a.company) === normaliseCompanyName(b.company);
}

/**
 * A same-role candidate: same company scope and same normalised title, and with
 * `location: true` the same normalised location too (dedupe uses it; the reapply cooldown
 * doesn't). A candidate still needs the LLM's confirmation.
 */
export function sameRole(a: RoleRef, b: RoleRef, opts: { location: boolean }): boolean {
  if (!sameCompany(a, b)) return false;
  if (normaliseTitle(a.title) !== normaliseTitle(b.title)) return false;
  return !opts.location || normaliseLocation(a.location) === normaliseLocation(b.location);
}
