// Pipeline records for the view tests. view.test.ts checks the built page as text, and
// view-browser.test.ts opens the same page in a real browser, so both build it from here.
import assert from "node:assert/strict";
import { runCli } from "./harness.ts";

/** A screened Listing in the shape Discover and Screen write (core-conventions.md). */
export function listing(jobId: string, title: string, extra: Record<string, unknown> = {}) {
  const id = `greenhouse:acme:${jobId}`;
  return {
    id,
    body: {
      source: "greenhouse",
      board: "greenhouse:acme",
      company: "Acme",
      source_job_id: jobId,
      title,
      location: "London",
      url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}`,
      description: `${title} at Acme.`,
      aliases: [{ id, url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}` }],
      sightings: [],
      first_seen_at: "2026-01-14T07:00:00.000Z",
      last_seen_at: "2026-01-14T07:00:00.000Z",
      gone: false,
      gone_at: null,
      decision_tree: `decision-trees/${encodeURIComponent(id)}.mmd`,
      ...extra,
    },
  };
}

export function check(
  name: string,
  status: "pass" | "warn" | "fail" | "not_reached",
  extra: Record<string, unknown> = {},
) {
  return {
    check: `step.${name.toLowerCase().replace(/\W+/g, "_")}`,
    name,
    rule: `${name} rule`,
    result: status === "not_reached" ? "not reached" : status,
    status,
    effect: null,
    citation: `${name} citation`,
    evidence: [`${name} evidence line`],
    label: null,
    ...extra,
  };
}

export function screen(outcome: "shortlist" | "excluded", checks: unknown[], extra = {}) {
  return {
    screened_at: "2026-01-14T08:00:00.000Z",
    run_id: null,
    outcome,
    excluded_by: null,
    checks,
    flags: [],
    badges: [],
    rescore_requested_at: null,
    ...extra,
  };
}

export const FIT = (score: number, band: string) => ({ score, band });

export const SHORT_A = listing("101", "Senior Backend Engineer", {
  screen: screen("shortlist", [check("Scam gate", "pass"), check("Fit score", "pass")], {
    fit: FIT(86, "strong"),
  }),
});
export const SHORT_B = listing("102", "Platform Engineer", {
  screen: screen("shortlist", [check("Scam gate", "pass"), check("Ghost score", "warn")], {
    fit: FIT(61, "partial"),
    flags: [{ check: "step.ghost_score", label: "ghost: high" }],
  }),
});
export const EXCLUDED = listing("103", "Crypto Wizard", {
  screen: screen(
    "excluded",
    [
      check("Scam gate", "fail", { effect: "exclude", evidence: ["asks for a fee upfront"] }),
      check("Fit score", "not_reached"),
    ],
    { excluded_by: "step.scam_gate" },
  ),
});
export const PAUSED = listing("104", "Backend Engineer II", {
  application_id: "app-paused",
  screen: screen("shortlist", [check("Scam gate", "pass")], { fit: FIT(77, "partial") }),
});
export const HANDOVER = listing("105", "Staff Engineer", {
  application_id: "app-handover",
  screen: screen("shortlist", [check("Scam gate", "pass")], { fit: FIT(81, "strong") }),
});

export function application(
  id: string,
  listingId: string | null,
  title: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    body: {
      origin: listingId === null ? "external" : "picked",
      listing: listingId,
      company: "Acme",
      title,
      status,
      event_log: [
        {
          at: "2026-01-14T09:00:00.000Z",
          stage: "screen",
          from: null,
          to: "picked",
          reason: "Picked from the Shortlist (Fit 80 strong).",
          approval: {
            id: "ap-1",
            checkpoint: "shortlist-pick",
            approved_at: "2026-01-14T08:59:00.000Z",
            action: `application pick ${listingId}`,
          },
        },
      ],
      gmail_threads: [],
      answers: [],
      ...extra,
    },
  };
}

export const APPS = [
  application("app-paused", PAUSED.id, "Backend Engineer II", "paused", {
    pause: { field: "Right to work: visa expiry date" },
  }),
  application("app-handover", HANDOVER.id, "Staff Engineer", "handover"),
  application("app-ext", null, "Data Engineer", "submitted"),
  application("app-change", null, "Analyst", "submitted", {
    pending_change: { to: "interview", reason: "Invite matched by thread" },
  }),
];

export const DISCOVER_RUN = {
  id: "run-1",
  body: {
    started_at: "2026-01-15T08:00:00.000Z",
    finished_at: "2026-01-15T08:02:00.000Z",
    run_id: null,
    sources: [
      {
        id: "greenhouse:acme",
        ats: "greenhouse",
        company: "Acme",
        status: "ok",
        jobs: 3,
        error: null,
      },
      {
        id: "workday:adatum:ext",
        ats: "workday",
        company: "Adatum",
        status: "failed",
        jobs: 0,
        error: {
          code: "BOARD_CHANGED_SHAPE",
          message: "Adatum's board answered with an unexpected shape.",
        },
      },
    ],
    new_listings: [],
    gone_listings: [],
    listings_seen: 3,
  },
};

export async function put(dataDir: string, type: string, rec: { id: string; body: unknown }) {
  const r = await runCli(["record", "put", type, rec.id, "--input", "-"], {
    dataDir,
    input: rec.body,
  });
  assert.equal(r.code, 0, r.stdout);
}

export async function seed(dataDir: string) {
  for (const l of [SHORT_A, SHORT_B, EXCLUDED, PAUSED, HANDOVER]) await put(dataDir, "listing", l);
  for (const a of APPS) await put(dataDir, "application", a);
  await put(dataDir, "discover-run", DISCOVER_RUN);
}
/** Markup that must reach the page as text only: an image whose error handler sets a flag. */
export const HOSTILE = '<img src=x onerror="window.jbPwned=1">';

/** A Listing and its Application with HOSTILE in every field that reaches the decision tree, and as a check's evidence. */
const HOSTILE_LISTING = listing("301", HOSTILE, {
  company: HOSTILE,
  location: HOSTILE,
  screen: screen(
    "shortlist",
    [
      check(HOSTILE, "pass", {
        rule: HOSTILE,
        result: HOSTILE,
        citation: HOSTILE,
        evidence: [HOSTILE],
      }),
      check("Fit score", "pass"),
    ],
    { fit: FIT(70, "partial") },
  ),
});

const HOSTILE_APPLICATION = application("app-hostile", HOSTILE_LISTING.id, HOSTILE, "picked", {
  company: HOSTILE,
  event_log: [
    {
      at: "2026-01-14T09:00:00.000Z",
      stage: "screen",
      from: null,
      to: "picked",
      reason: HOSTILE,
      approval: null,
    },
  ],
});

/** The hostile Listing and Application, written as Discover and Picking write them. */
export async function seedHostile(dataDir: string) {
  await put(dataDir, "listing", HOSTILE_LISTING);
  await put(dataDir, "application", HOSTILE_APPLICATION);
}
