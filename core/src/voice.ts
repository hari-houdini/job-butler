// Voice rules for free-text answers Apply writes (#45): forbidden words and patterns that
// make an answer read as machine-written. The read-back checks every written answer
// against them, and a violation blocks the Handover.

/** Whole words, matched case-insensitively. */
export const FORBIDDEN_WORDS = [
  "delve",
  "delving",
  "tapestry",
  "testament",
  "synergy",
  "synergies",
  "rockstar",
  "ninja",
  "guru",
  "passionate",
  "thrilled",
  "leverage",
  "utilise",
  "utilize",
  "spearhead",
  "spearheaded",
  "seamless",
  "seamlessly",
];

/** Patterns, each with the name shown to the job seeker. */
export const FORBIDDEN_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "an em dash", pattern: /—/ },
  {
    name: '"I am excited to"',
    pattern: /\bI(?:'m| am) (?:so |very |really )?excited (?:to|about)\b/i,
  },
  { name: '"fast-paced"', pattern: /\bfast[- ]paced\b/i },
  { name: '"not just ... but"', pattern: /\bnot just\b[^.]*\bbut\b/i },
  { name: '"I would love to"', pattern: /\bI would love to\b/i },
  { name: '"in today\'s"', pattern: /\bin today['’]s\b/i },
];

/** Every rule the text breaks, as readable names. Empty when it is clean. */
export function voiceViolations(text: string): string[] {
  const found: string[] = [];
  for (const w of FORBIDDEN_WORDS) {
    if (new RegExp(`\\b${w}\\b`, "i").test(text)) found.push(`the word "${w}"`);
  }
  for (const { name, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) found.push(name);
  }
  return found;
}
