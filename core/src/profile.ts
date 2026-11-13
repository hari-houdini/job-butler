import { access } from "node:fs/promises";
import { join } from "node:path";

/** The Profile lives at <data dir>/profile.yaml (written only by setup). */
export function profilePath(dataDir: string): string {
  return join(dataDir, "profile.yaml");
}

/** "missing" until setup writes a Profile. Completeness checks come with the setup ticket. */
export async function profileState(dataDir: string): Promise<"missing" | "present"> {
  try {
    await access(profilePath(dataDir));
    return "present";
  } catch {
    return "missing";
  }
}
