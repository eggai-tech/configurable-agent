/** `JSON.stringify` that never throws — falls back to `String()` on cycles, BigInt, etc. */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return safeJson(err);
}

/**
 * Read an integer from the environment, or the fallback when the variable is
 * unset or not numeric. Any integer is accepted so operators can use `0` to
 * mean "disabled" for features that support it.
 */
export function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
