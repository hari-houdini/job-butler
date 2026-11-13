/**
 * An expected refusal or failure the job seeker should hear about. The CLI prints it as
 * {"ok": false, "error": {"code", "message"}} and exits with `exitCode`.
 * `message` is written for the job seeker: plain words, what happened and what to do.
 */
export class CoreError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>, exitCode = 1) {
    super(message);
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

/** Wrong command line: unknown command, missing argument, bad flag. Exit code 2. */
export function usageError(message: string): CoreError {
  return new CoreError("USAGE", message, undefined, 2);
}
