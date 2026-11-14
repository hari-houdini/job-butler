// The Greenhouse application form schema (Apply, #45): the job's board API with
// `?questions=true`, e.g. https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true
// Shape: `questions` and `location_questions` are `[{label, required, fields: [{name, type, values}]}]`.
// A 404 means the posting is gone. Reads only; never writes pipeline state.
import { CoreError } from "../errors.ts";
import { httpGet } from "../net.ts";
import { isObject } from "../validate.ts";

export type FieldType = "text" | "textarea" | "file" | "select" | "multi_select";

export interface FormOption {
  label: string;
  value: string;
}

export interface FormField {
  /** The form control's name, e.g. `first_name` or `question_69854137`. */
  name: string;
  label: string;
  required: boolean;
  type: FieldType;
  /** Choices for select fields; empty otherwise. */
  options: FormOption[];
}

export interface FormSchema {
  board_token: string;
  job_id: string;
  fetched_at: string;
  fields: FormField[];
}

const TYPES: Record<string, FieldType | "hidden"> = {
  input_text: "text",
  textarea: "textarea",
  input_file: "file",
  multi_value_single_select: "select",
  multi_value_multi_select: "multi_select",
  input_hidden: "hidden",
};

/** The posting is gone from its board (404), or the board answered in a shape we don't know. */
export class PostingGone extends CoreError {}

export async function readGreenhouseForm(
  token: string,
  jobId: string,
  fetchedAt: string,
): Promise<FormSchema> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}?questions=true`;
  const res = await httpGet(url);
  if (res.status === 404) {
    throw new PostingGone(
      "POSTING_GONE",
      `This job is no longer on Greenhouse (404 from ${url}). It has probably been taken down.`,
      { status: res.status },
    );
  }
  if (res.status < 200 || res.status > 299) {
    throw new CoreError(
      "FORM_UNAVAILABLE",
      `Greenhouse's form for this job couldn't be read (HTTP ${res.status} from ${url}). Try again later.`,
      { status: res.status },
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    throw changed(url, "the response isn't JSON");
  }
  if (!isObject(body) || !Array.isArray(body.questions)) throw changed(url, "no questions list");
  const groups = [
    ...(body.questions as unknown[]),
    ...(Array.isArray(body.location_questions) ? body.location_questions : []),
  ];
  const fields: FormField[] = [];
  for (const q of groups) {
    if (!isObject(q) || typeof q.label !== "string" || !Array.isArray(q.fields)) {
      throw changed(url, "a question has no label or fields");
    }
    // A question with several controls (file or pasted text) is required once: on the first.
    let first = true;
    for (const f of q.fields) {
      if (!isObject(f) || typeof f.name !== "string" || typeof f.type !== "string") {
        throw changed(url, `a field of "${q.label}" has no name or type`);
      }
      const type = TYPES[f.type];
      if (type === undefined) throw changed(url, `field ${f.name} has the unknown type ${f.type}`);
      if (type === "hidden") continue;
      fields.push({
        name: f.name,
        label: q.label.trim(),
        required: q.required === true && first,
        type,
        options: (Array.isArray(f.values) ? f.values : []).flatMap((v) =>
          isObject(v) && typeof v.label === "string"
            ? [{ label: v.label, value: String(v.value) }]
            : [],
        ),
      });
      first = false;
    }
  }
  return { board_token: token, job_id: jobId, fetched_at: fetchedAt, fields };
}

function changed(url: string, detail: string): CoreError {
  return new CoreError(
    "FORM_CHANGED_SHAPE",
    `Greenhouse's form answered in a shape Apply doesn't recognise (${detail}, from ${url}).`,
  );
}
