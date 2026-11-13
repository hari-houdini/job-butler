// Every network fetch the core makes goes through httpGet (or httpPostJson). When
// JOB_BUTLER_NETWORK_FIXTURES is set (always, in tests) responses come from <dir>/manifest.json
// instead of the network:
//   { "<url>": { "status": 200, "content_type": "application/json", "file": "<file in dir>" } }
// A POST is keyed "POST <url> <body>", with the JSON body exactly as sent.
// A URL missing from the manifest is refused, so tests never go online by accident.
// Loopback URLs (127.0.0.1, localhost) are always fetched live: they serve browser fixtures.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { networkFixturesDir } from "./env.ts";
import { CoreError } from "./errors.ts";

export interface HttpResponse {
  url: string;
  status: number;
  content_type: string;
  body: string;
}

interface FixtureEntry {
  status: number;
  content_type: string;
  file: string;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

/** GET a URL. `headers` are extra request headers (Companies House takes Basic auth). */
export function httpGet(rawUrl: string, headers?: Record<string, string>): Promise<HttpResponse> {
  return request(rawUrl, undefined, headers);
}

/** POST a JSON body and ask for JSON back (Workday's cxs search). */
export function httpPostJson(rawUrl: string, body: unknown): Promise<HttpResponse> {
  return request(rawUrl, JSON.stringify(body));
}

async function request(
  rawUrl: string,
  jsonBody?: string,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CoreError("BAD_URL", `Not a valid URL: ${rawUrl}`);
  }

  const fixtures = networkFixturesDir();
  if (fixtures !== undefined && !isLoopback(url)) {
    const manifest = JSON.parse(await readFile(join(fixtures, "manifest.json"), "utf8")) as Record<
      string,
      FixtureEntry
    >;
    const key = jsonBody === undefined ? rawUrl : `POST ${rawUrl} ${jsonBody}`;
    const entry = manifest[key];
    if (entry === undefined) {
      throw new CoreError(
        "NETWORK_FIXTURE_MISSING",
        `No recorded response for ${key} in ${fixtures}/manifest.json.`,
      );
    }
    const body = await readFile(join(fixtures, entry.file), "utf8");
    return { url: rawUrl, status: entry.status, content_type: entry.content_type, body };
  }

  let res: Response;
  try {
    const init: RequestInit =
      jsonBody === undefined
        ? { headers: { "user-agent": "job-butler", ...headers } }
        : {
            method: "POST",
            headers: {
              "user-agent": "job-butler",
              "content-type": "application/json",
              accept: "application/json",
            },
            body: jsonBody,
          };
    res = await fetch(url, { ...init, redirect: "follow" });
  } catch (e) {
    throw new CoreError("NETWORK_ERROR", `Could not reach ${rawUrl}: ${(e as Error).message}`);
  }
  return {
    url: res.url,
    status: res.status,
    content_type: res.headers.get("content-type") ?? "",
    body: await res.text(),
  };
}
