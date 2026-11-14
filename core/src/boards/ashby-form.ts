// The Ashby application form (Apply, #46). Ashby's hosted page is rendered in the browser and
// has no public form API, so the form is read from a snapshot of the page's controls (the page
// driver's `controls()`), and each field is identified by its label. A missing posting or a
// page that can't be opened pauses the Application.
import { openDriver, type PageControl, PageError } from "../apply-driver.ts";
import { CoreError } from "../errors.ts";
import type { FieldType, FormField, FormSchema } from "./greenhouse-form.ts";

export class AshbyPostingGone extends CoreError {}

const TYPES: Partial<Record<PageControl["kind"], FieldType>> = {
  text: "text",
  textarea: "textarea",
  select: "select",
  file: "file",
};

/** Map a page snapshot to the form model; labels lose their required marker. */
export function ashbyFields(controls: PageControl[]): FormField[] {
  const fields: FormField[] = [];
  for (const c of controls) {
    const type = TYPES[c.kind];
    if (type === undefined || c.submits || c.name === "") continue;
    const marked = /[*✱]\s*$/.test(c.label);
    const label = c.label.replace(/\s*[*✱]+\s*$/, "").trim();
    fields.push({
      name: c.name,
      label: label === "" ? c.name : label,
      required: c.required || marked,
      type,
      options: (c.options ?? [])
        .filter((o) => o.trim() !== "")
        .map((o) => ({ label: o, value: o })),
    });
  }
  return fields;
}

export async function readAshbyForm(
  formUrl: string,
  token: string,
  jobId: string,
  fetchedAt: string,
): Promise<FormSchema> {
  const driver = await openDriver();
  try {
    let controls: PageControl[];
    try {
      await driver.open(formUrl);
      controls = await driver.controls();
    } catch (e) {
      if (!(e instanceof PageError)) throw e;
      throw new AshbyPostingGone(
        "POSTING_GONE",
        `The Ashby application page couldn't be opened (${e.message}), so the posting is probably gone.`,
      );
    }
    const fields = ashbyFields(controls);
    if (fields.length === 0) {
      throw new CoreError(
        "FORM_CHANGED_SHAPE",
        `The Ashby application page at ${formUrl} has no fields Apply recognises.`,
      );
    }
    return { board_token: token, job_id: jobId, fetched_at: fetchedAt, fields };
  } finally {
    await driver.close();
  }
}
