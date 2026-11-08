/** Secrets set with `wrangler secret put` by CI — not visible to `wrangler types`. */
export interface Secrets {
  GEMINI_API_KEY: string;
  /** base64url, 32 bytes. Generated once by CI if absent; rotating it signs everyone out. */
  SESSION_SIGNING_KEY: string;
  /** The same enrollment token mythosengine uses (CONSOLE_ENROLLMENT_TOKEN there). */
  ENROLLMENT_TOKEN: string;
  /** Local only; see sessionFor in index.ts. */
  DEV_BYPASS_AUTH?: string;
}

export type AppEnv = Env & Secrets;

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
