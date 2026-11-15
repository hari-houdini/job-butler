// Direct unit tests of the Track match ladder (ticket D2 of #67). The ladder is pure: it takes
// a context of Applications and one classified message, and returns the match. No data
// directory, no CLI. The CLI-level ladder tests stay in track-ladder.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredRecord } from "../src/store.ts";
import {
  LADDER,
  type LadderContext,
  type LadderMessage,
  type Match,
  matchMessage,
} from "../src/track-ladder.ts";

type Entry = LadderContext["apps"][number];
type Alias = Entry["aliases"][number];

const STAMP = "2026-01-15T09:00:00.000Z";

/** An Application record as the ladder reads it: open ("submitted") unless a status is given. */
function app(id: string, company: string, title: string, fields: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    id,
    created_at: STAMP,
    updated_at: STAMP,
    company,
    title,
    status: "submitted",
    gmail_threads: [],
    calendar_events: [],
    ...fields,
  } as StoredRecord;
}

/** A context entry: the Application, its Listing's aliases and its Employer's ID, when it has one. */
function entry(
  record: StoredRecord,
  options: { aliases?: Alias[]; employerId?: string } = {},
): Entry {
  return {
    app: record,
    aliases: options.aliases ?? [],
    ...(options.employerId !== undefined ? { employerId: options.employerId } : {}),
  };
}

const ctx = (...entries: Entry[]): LadderContext => ({ apps: entries });

/** A classified message that names no Application by default. */
function mail(fields: Partial<LadderMessage> = {}): LadderMessage {
  return {
    thread_id: "thread-unknown",
    from: "Recruiter <recruiter@mailer.example>",
    ...fields,
  };
}

test("the ladder runs five steps in order: thread, ATS ID, mail domain, named sender, body", () => {
  assert.deepEqual(
    LADDER.map((s) => [s.step, s.name]),
    [
      [1, "thread"],
      [2, "ATS ID"],
      [3, "mail domain"],
      [4, "named sender"],
      [5, "body"],
    ],
  );
});

test("a Gmail thread the Application holds is a sure match at step 1", () => {
  const a = app("app-a", "Northwind", "Data Engineer", { gmail_threads: ["thread-1"] });
  const b = app("app-b", "Contoso", "Analyst");
  const m = matchMessage(mail({ thread_id: "thread-1" }), ctx(entry(a), entry(b)));
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 1);
  assert.equal(m.confidence, "sure");
  assert.equal(m.note, undefined);
});

test("a calendar event matches by its event ID through calendar_events, not gmail_threads", () => {
  const a = app("app-a", "Northwind", "Data Engineer", { calendar_events: ["evt-9"] });
  const b = app("app-b", "Contoso", "Analyst", { gmail_threads: ["evt-9"] });
  const m = matchMessage(mail({ thread_id: "evt-9", source: "calendar" }), ctx(entry(a), entry(b)));
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 1);
});

test("a thread match settles the message before a later step could name another Application", () => {
  const a = app("app-a", "Northwind", "Data Engineer", { gmail_threads: ["thread-1"] });
  const b = app("app-b", "Fabrikam", "Analyst");
  const m = matchMessage(
    mail({ thread_id: "thread-1", from: "Fabrikam <hr@fabrikam.example>" }),
    ctx(entry(a), entry(b)),
  );
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 1);
});

test("step 1 still matches a closed Application by its thread", () => {
  const a = app("app-a", "Northwind", "Data Engineer", {
    status: "rejected",
    gmail_threads: ["thread-1"],
  });
  const m = matchMessage(mail({ thread_id: "thread-1" }), ctx(entry(a)));
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 1);
  assert.equal(m.confidence, "sure");
});

test("a job URL equal to an alias's posting URL is a sure match at step 2", () => {
  const url = "https://jobs.lever.co/northwind/abc-123";
  const a = app("app-a", "Northwind", "Data Engineer");
  const b = app("app-b", "Contoso", "Analyst");
  const aliasA: Alias = {
    id: "lever:northwind:abc-123",
    url,
    board: "lever:northwind",
    source_job_id: "abc-123",
  };
  const aliasB: Alias = {
    id: "lever:contoso:zzz-9",
    url: "https://jobs.lever.co/contoso/zzz-9",
    board: "lever:contoso",
    source_job_id: "zzz-9",
  };
  const m = matchMessage(
    mail({ ats: { job_url: url } }),
    ctx(entry(a, { aliases: [aliasA] }), entry(b, { aliases: [aliasB] })),
  );
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 2);
  assert.equal(m.confidence, "sure");
});

test("a job ID with its board slug matches the posting, but the same ID on another board does not", () => {
  const a = app("app-a", "Northwind", "Data Engineer");
  const alias: Alias = {
    id: "lever:northwind:abc-123",
    url: null,
    board: "lever:northwind",
    source_job_id: "abc-123",
  };
  const context = ctx(entry(a, { aliases: [alias] }));

  const same = matchMessage(mail({ ats: { job_id: "abc-123", board_slug: "northwind" } }), context);
  assert.equal(same.kind, "matched");
  if (same.kind !== "matched") return;
  assert.equal(same.app.id, "app-a");
  assert.equal(same.step.step, 2);
  assert.equal(same.confidence, "sure");

  const other = matchMessage(mail({ ats: { job_id: "abc-123", board_slug: "globex" } }), context);
  assert.equal(other.kind, "unmatched");
});

test("a board slug alone narrows to the one Application on that board, sure at step 2", () => {
  const a = app("app-a", "Northwind", "Data Engineer");
  const b = app("app-b", "Contoso", "Analyst");
  const aliasA: Alias = {
    id: "lever:northwind:1",
    url: null,
    board: "lever:northwind",
    source_job_id: "1",
  };
  const aliasB: Alias = {
    id: "lever:contoso:2",
    url: null,
    board: "lever:contoso",
    source_job_id: "2",
  };
  const m = matchMessage(
    mail({ ats: { board_slug: "northwind" } }),
    ctx(entry(a, { aliases: [aliasA] }), entry(b, { aliases: [aliasB] })),
  );
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 2);
  assert.equal(m.confidence, "sure");
});

test("a board slug on several Applications is ambiguous at step 2 and the ladder carries on", () => {
  const a = app("app-a", "Northwind", "Data Engineer");
  const b = app("app-b", "Northwind", "Product Designer");
  const aliasA: Alias = {
    id: "lever:northwind:1",
    url: null,
    board: "lever:northwind",
    source_job_id: "1",
  };
  const aliasB: Alias = {
    id: "lever:northwind:2",
    url: null,
    board: "lever:northwind",
    source_job_id: "2",
  };
  const m = matchMessage(
    mail({ ats: { board_slug: "northwind" } }),
    ctx(entry(a, { aliases: [aliasA] }), entry(b, { aliases: [aliasB] })),
  );
  assert.equal(m.kind, "ambiguous");
  if (m.kind !== "ambiguous") return;
  assert.deepEqual(
    m.candidates.map((c) => c.app.id),
    ["app-a", "app-b"],
  );
  assert.equal(m.candidates[0]?.reason, "ATS ID matches");
});

test("a Workday tenant narrows to the Applications on that tenant's boards, sure at step 2", () => {
  const a = app("app-a", "Globex", "Data Engineer");
  const b = app("app-b", "Contoso", "Analyst");
  const aliasA: Alias = {
    id: "workday:globex:careers:R-1",
    url: null,
    board: "workday:globex:careers",
    source_job_id: "R-1",
  };
  const aliasB: Alias = {
    id: "lever:contoso:2",
    url: null,
    board: "lever:contoso",
    source_job_id: "2",
  };
  const m = matchMessage(
    mail({ ats: { workday_tenant: "Globex" } }),
    ctx(entry(a, { aliases: [aliasA] }), entry(b, { aliases: [aliasB] })),
  );
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 2);
  assert.equal(m.confidence, "sure");
});

test("a domain learned for an open Application matches at step 3, sure when it is the Employer's only open one", () => {
  const a = app("app-a", "Northwind", "Data Engineer", { mail_domains: ["northwind.example"] });
  const b = app("app-b", "Contoso", "Analyst");
  const m = matchMessage(mail({ from: "Jobs <jobs@northwind.example>" }), ctx(entry(a), entry(b)));
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 3);
  assert.equal(m.domain, "northwind.example");
  assert.equal(m.confidence, "sure");
});

test("a learned domain shared with another open Application at the same Employer is probable, with a note", () => {
  const a = app("app-a", "Northwind", "Data Engineer", { mail_domains: ["northwind.example"] });
  const c = app("app-c", "Northwind", "Product Designer");
  const m = matchMessage(mail({ from: "jobs@northwind.example" }), ctx(entry(a), entry(c)));
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 3);
  assert.equal(m.confidence, "probable");
  assert.equal(
    m.note,
    "mail from northwind.example, a mail domain learned for Northwind, but Northwind has other open Applications",
  );
});

test("two Applications with the same company name but different Employer records are not one Employer", () => {
  const a = app("app-a", "Northwind", "Data Engineer", { mail_domains: ["northwind.example"] });
  const c = app("app-c", "Northwind", "Product Designer");
  const m = matchMessage(
    mail({ from: "jobs@northwind.example" }),
    ctx(entry(a, { employerId: "emp-1" }), entry(c, { employerId: "emp-2" })),
  );
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.confidence, "sure");
});

test("the Reply-To domain is tried when the sender's domain is not learned", () => {
  const a = app("app-a", "Northwind", "Data Engineer", { mail_domains: ["northwind.example"] });
  const m = matchMessage(
    mail({ from: "jobs@mailer.example", reply_to: "hr@northwind.example" }),
    ctx(entry(a)),
  );
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 3);
  assert.equal(m.domain, "northwind.example");
});

test("a vendor or free-mail sender never teaches Track a domain, so it cannot match at step 3", () => {
  const a = app("app-a", "Northwind", "Data Engineer", {
    mail_domains: ["greenhouse.io", "gmail.com"],
  });
  const context = ctx(entry(a));
  assert.equal(matchMessage(mail({ from: "no-reply@greenhouse.io" }), context).kind, "unmatched");
  assert.equal(matchMessage(mail({ from: "jobs@gmail.com" }), context).kind, "unmatched");
});

test("a closed Application is never matched by its learned domain", () => {
  const a = app("app-a", "Northwind", "Data Engineer", {
    status: "rejected",
    mail_domains: ["northwind.example"],
  });
  const m = matchMessage(mail({ from: "jobs@northwind.example" }), ctx(entry(a)));
  assert.equal(m.kind, "unmatched");
});

test("a sender's display name naming an open Application's company matches at step 4, probable", () => {
  const a = app("app-a", "Northwind", "Data Engineer");
  const m = matchMessage(mail({ from: "Northwind Talent <talent@mailer.example>" }), ctx(entry(a)));
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 4);
  assert.equal(m.confidence, "probable");
  assert.equal(m.note, "the sender or signature names Northwind");
});

test("a signature naming the company matches at step 4", () => {
  const a = app("app-a", "Fabrikam", "Data Engineer");
  const m = matchMessage(
    mail({ from: "talent@mailer.example", signature: "Regards, Fabrikam Recruiting" }),
    ctx(entry(a)),
  );
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-a");
  assert.equal(m.step.step, 4);
});

test("a closed Application is never matched by its sender's name", () => {
  const a = app("app-a", "Northwind", "Data Engineer", { status: "withdrawn" });
  const m = matchMessage(mail({ from: "Northwind Talent <talent@mailer.example>" }), ctx(entry(a)));
  assert.equal(m.kind, "unmatched");
});

test("a body naming the company matches at step 5, and the role picks one of several Applications", () => {
  const a = app("app-a", "Northwind", "Data Engineer");
  const b = app("app-b", "Northwind", "Product Designer");
  const m = matchMessage(
    mail({ from: "careers@mailer.example", company: "Northwind", role: "Product Designer" }),
    ctx(entry(a), entry(b)),
  );
  assert.equal(m.kind, "matched");
  if (m.kind !== "matched") return;
  assert.equal(m.app.id, "app-b");
  assert.equal(m.step.step, 5);
  assert.equal(m.confidence, "probable");
  assert.equal(m.note, 'the message names Northwind and "Product Designer"');
});

test("without a role, a body naming a company with several open Applications is ambiguous", () => {
  const a = app("app-a", "Northwind", "Data Engineer");
  const b = app("app-b", "Northwind", "Product Designer");
  const m = matchMessage(
    mail({ from: "careers@mailer.example", company: "Northwind" }),
    ctx(entry(a), entry(b)),
  );
  assert.equal(m.kind, "ambiguous");
  if (m.kind !== "ambiguous") return;
  assert.deepEqual(
    m.candidates.map((c) => c.app.id),
    ["app-a", "app-b"],
  );
  assert.equal(m.candidates[0]?.reason, "the message names Northwind");
});

test("a role that matches neither Application keeps every company match", () => {
  const a = app("app-a", "Northwind", "Data Engineer");
  const b = app("app-b", "Northwind", "Product Designer");
  const m = matchMessage(
    mail({ from: "careers@mailer.example", company: "Northwind", role: "Sales Associate" }),
    ctx(entry(a), entry(b)),
  );
  assert.equal(m.kind, "ambiguous");
  if (m.kind !== "ambiguous") return;
  assert.deepEqual(
    m.candidates.map((c) => c.app.id),
    ["app-a", "app-b"],
  );
});

test("a body with a blank company names nothing", () => {
  const a = app("app-a", "Northwind", "Data Engineer");
  assert.equal(
    matchMessage(mail({ from: "careers@mailer.example", company: "   " }), ctx(entry(a))).kind,
    "unmatched",
  );
});

test("ambiguous candidates rank the Application whose role matches the message first", () => {
  const a = app("app-a", "Northwind", "Data Engineer", { gmail_threads: ["thread-1"] });
  const b = app("app-b", "Northwind", "Product Designer", { gmail_threads: ["thread-1"] });
  const m = matchMessage(
    mail({ thread_id: "thread-1", role: "Product Designer" }),
    ctx(entry(a), entry(b)),
  );
  assert.equal(m.kind, "ambiguous");
  if (m.kind !== "ambiguous") return;
  assert.deepEqual(
    m.candidates.map((c) => c.app.id),
    ["app-b", "app-a"],
  );
  assert.equal(m.candidates[0]?.reason, "thread matches");
});

test("ambiguous candidates rank an open Application above a closed one with the same thread", () => {
  const open = app("app-open", "Northwind", "Data Engineer", { gmail_threads: ["thread-1"] });
  const closed = app("app-closed", "Northwind", "Data Engineer", {
    status: "rejected",
    gmail_threads: ["thread-1"],
  });
  const m = matchMessage(mail({ thread_id: "thread-1" }), ctx(entry(closed), entry(open)));
  assert.equal(m.kind, "ambiguous");
  if (m.kind !== "ambiguous") return;
  assert.deepEqual(
    m.candidates.map((c) => c.app.id),
    ["app-open", "app-closed"],
  );
});

test("a message that names no Application is unmatched", () => {
  const a = app("app-a", "Northwind", "Data Engineer", { mail_domains: ["northwind.example"] });
  const b = app("app-b", "Contoso", "Analyst");
  const m: Match = matchMessage(mail({ from: "news@mailer.example" }), ctx(entry(a), entry(b)));
  assert.deepEqual(m, { kind: "unmatched" });
});
