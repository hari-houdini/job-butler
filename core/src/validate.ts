// Shape checks for the human-edited files. Each check pushes a plain-words problem with the
// dotted path of the bad value, so a job seeker can find it in the YAML file.

export type Problems = string[];

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function describe(v: unknown): string {
  if (v === undefined) return "missing";
  return `got ${JSON.stringify(v)}`;
}

/** Check `v` is a mapping with exactly the allowed keys; returns it or undefined. */
export function object(
  v: unknown,
  path: string,
  allowed: readonly string[],
  problems: Problems,
): Record<string, unknown> | undefined {
  if (!isObject(v)) {
    problems.push(`${path} must be a mapping (${describe(v)})`);
    return undefined;
  }
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) {
      problems.push(`${path}.${k} is not a known setting (expected one of: ${allowed.join(", ")})`);
    }
  }
  return v;
}

export function string(v: unknown, path: string, problems: Problems, nonEmpty = true): boolean {
  if (typeof v !== "string" || (nonEmpty && v.trim() === "")) {
    problems.push(`${path} must be ${nonEmpty ? "non-empty " : ""}text (${describe(v)})`);
    return false;
  }
  return true;
}

export function optionalString(v: unknown, path: string, problems: Problems): void {
  if (v !== undefined && v !== null) string(v, path, problems);
}

export function boolean(v: unknown, path: string, problems: Problems): boolean {
  if (typeof v !== "boolean") {
    problems.push(`${path} must be true or false (${describe(v)})`);
    return false;
  }
  return true;
}

export function integer(
  v: unknown,
  path: string,
  problems: Problems,
  min: number,
  max: number,
): boolean {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    problems.push(`${path} must be a whole number from ${min} to ${max} (${describe(v)})`);
    return false;
  }
  return true;
}

export function oneOf(
  v: unknown,
  path: string,
  options: readonly unknown[],
  problems: Problems,
): boolean {
  if (!options.includes(v)) {
    problems.push(`${path} must be one of: ${options.join(", ")} (${describe(v)})`);
    return false;
  }
  return true;
}

export function list(v: unknown, path: string, problems: Problems): unknown[] | undefined {
  if (!Array.isArray(v)) {
    problems.push(`${path} must be a list (${describe(v)})`);
    return undefined;
  }
  return v;
}

export function stringList(v: unknown, path: string, problems: Problems): string[] | undefined {
  const items = list(v, path, problems);
  items?.forEach((x, i) => {
    string(x, `${path}[${i}]`, problems);
  });
  return items as string[] | undefined;
}
