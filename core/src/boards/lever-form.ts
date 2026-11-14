// The Lever hosted apply form (Apply, #46): the page at https://jobs.lever.co/{site}/{id}/apply
// (EU: jobs.eu.lever.co). Each `<li class="application-question ...">` holds a label and one
// or more controls. Standard fields have stable names (`name`, `email`, `phone`, `org`,
// `urls[LinkedIn]`, `comments`, `resume`, `eeo[...]`) and the posting's own questions are
// `cards[<uuid>][field<n>]`. A 404 means the posting is gone. Reads only.
import { CoreError } from "../errors.ts";
import { htmlToText } from "../html-text.ts";
import { httpGet } from "../net.ts";
import type { FieldType, FormField, FormOption, FormSchema } from "./greenhouse-form.ts";

export class LeverPostingGone extends CoreError {}

const attrs = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(
    /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
  )) {
    out[(m[1] as string).toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
};

const text = (html: string) => htmlToText(html).replace(/[✱*]/g, "").replace(/\s+/g, " ").trim();

export async function readLeverForm(
  applyUrl: string,
  token: string,
  jobId: string,
  fetchedAt: string,
): Promise<FormSchema> {
  const res = await httpGet(applyUrl);
  if (res.status === 404) {
    throw new LeverPostingGone(
      "POSTING_GONE",
      `This job is no longer on Lever (404 from ${applyUrl}). It has probably been taken down.`,
      { status: res.status },
    );
  }
  if (res.status < 200 || res.status > 299) {
    throw new CoreError(
      "FORM_UNAVAILABLE",
      `Lever's apply page for this job couldn't be read (HTTP ${res.status} from ${applyUrl}). Try again later.`,
      { status: res.status },
    );
  }
  const blocks = res.body
    .split(/<li\b[^>]*class="[^"]*\bapplication-question\b[^"]*"[^>]*>/i)
    .slice(1);
  if (blocks.length === 0) throw changed(applyUrl, "no application questions on the page");
  const fields: FormField[] = [];
  for (const block of blocks) {
    const label = /<div[^>]*class="[^"]*\bapplication-label\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
      block,
    );
    const questionLabel = label === null ? "" : text(label[1] as string);
    const marked = label !== null && /class="[^"]*\brequired\b/i.test(label[1] as string);
    const seen = new Map<string, FormField>();
    let first = true;
    for (const m of block.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
      const tag = (m[1] as string).toLowerCase();
      const a = attrs(m[2] as string);
      const type = (a.type ?? "text").toLowerCase();
      if (a.name === undefined || a.name === "") continue;
      if (type === "hidden" || type === "submit" || type === "button" || type === "image") continue;
      const required = (marked || "required" in a) && first;
      if (type === "radio" || type === "checkbox") {
        const after = block.slice((m.index ?? 0) + m[0].length);
        const opt = /^\s*(?:<span[^>]*>)?([\s\S]*?)<\/(?:span|label)>/i.exec(after);
        const optLabel = opt === null ? (a.value ?? "") : text(opt[1] as string);
        const had = seen.get(a.name);
        const option: FormOption = { label: optLabel || (a.value ?? ""), value: a.value ?? "" };
        if (had !== undefined) {
          had.options.push(option);
          continue;
        }
        const field: FormField = {
          name: a.name,
          label: questionLabel || a.name,
          required,
          type: type === "radio" ? "select" : "multi_select",
          options: [option],
        };
        seen.set(a.name, field);
        fields.push(field);
        first = false;
        continue;
      }
      let ftype: FieldType = "text";
      let options: FormOption[] = [];
      if (tag === "textarea") ftype = "textarea";
      else if (type === "file") ftype = "file";
      else if (tag === "select") {
        ftype = "select";
        const end = block.indexOf("</select>", m.index ?? 0);
        const body = block.slice((m.index ?? 0) + m[0].length, end < 0 ? undefined : end);
        options = [...body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].flatMap((o) => {
          const v = attrs(o[1] as string).value ?? "";
          const l = text(o[2] as string);
          return v === "" || l === "" ? [] : [{ label: l, value: v }];
        });
      }
      fields.push({
        name: a.name,
        label: questionLabel || a.name,
        required,
        type: ftype,
        options,
      });
      first = false;
    }
  }
  if (fields.length === 0) throw changed(applyUrl, "no fillable fields");
  return { board_token: token, job_id: jobId, fetched_at: fetchedAt, fields };
}

function changed(url: string, detail: string): CoreError {
  return new CoreError(
    "FORM_CHANGED_SHAPE",
    `Lever's apply page answered in a shape Apply doesn't recognise (${detail}, from ${url}).`,
  );
}
