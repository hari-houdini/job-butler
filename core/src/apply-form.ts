// Where an Application's form is and how to read it (Apply, #45 Greenhouse, #46 Lever and
// Ashby). Every board reads into the same form model (`FormSchema`).
import { readAshbyForm } from "./boards/ashby-form.ts";
import { type FormSchema, readGreenhouseForm } from "./boards/greenhouse-form.ts";
import { readLeverForm } from "./boards/lever-form.ts";
import { CoreError } from "./errors.ts";
import type { StoredRecord } from "./store.ts";

export type FormAts = "greenhouse" | "lever" | "ashby";
export const FORM_ATS: FormAts[] = ["greenhouse", "lever", "ashby"];
export const ATS_NAME: Record<FormAts, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
};

export interface Target {
  ats: FormAts;
  token: string;
  jobId: string;
  /** The page that gets filled. */
  url: string;
}

const sourceOf = (a: { id: string; source?: string }) => a.source ?? a.id.split(":")[0] ?? "";

/** The employer-ATS copy of the Listing that Apply can fill, or undefined when there is none. */
export function formTarget(listing: StoredRecord): Target | undefined {
  const aliases = (listing.aliases as { id: string; url: string | null; source?: string }[]) ?? [];
  for (const a of aliases) {
    const ats = sourceOf(a) as FormAts;
    if (!FORM_ATS.includes(ats) || typeof a.url !== "string" || a.url === "") continue;
    const [, token, jobId] = a.id.split(":");
    if (token === undefined || jobId === undefined) continue;
    const base = a.url.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const url =
      ats === "lever"
        ? `${base.replace(/\/apply$/, "")}/apply`
        : ats === "ashby"
          ? `${base.replace(/\/application$/, "")}/application`
          : a.url;
    return { ats, token, jobId, url };
  }
  return undefined;
}

export async function readForm(
  t: { ats?: FormAts; token: string; jobId: string; url: string },
  fetchedAt: string,
): Promise<FormSchema> {
  switch (t.ats ?? "greenhouse") {
    case "greenhouse":
      return readGreenhouseForm(t.token, t.jobId, fetchedAt);
    case "lever":
      return readLeverForm(t.url, t.token, t.jobId, fetchedAt);
    case "ashby":
      return readAshbyForm(t.url, t.token, t.jobId, fetchedAt);
    default:
      throw new CoreError("FORM_UNAVAILABLE", "Apply doesn't fill forms on this board.");
  }
}
