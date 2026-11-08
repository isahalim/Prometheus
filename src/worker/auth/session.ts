// __Host-session cookie, ported from mythosengine (src/server/auth/session.ts):
// HttpOnly, Secure, SameSite=Strict, 12h TTL, HMAC-SHA256 over the payload with
// SESSION_SIGNING_KEY. Three fields and one signature — no JWT library.

export const SESSION_COOKIE_NAME = "__Host-session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionPayload {
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secretB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64Url(secretB64.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueSessionToken(sessionId: string, signingKeyB64: string, now: () => number = Date.now): Promise<string> {
  const issuedAt = Math.floor(now() / 1000);
  const payload: SessionPayload = { sessionId, issuedAt, expiresAt: issuedAt + SESSION_TTL_SECONDS };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await importHmacKey(signingKeyB64);
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${toBase64Url(payloadBytes)}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verifies signature and expiry. Never throws. */
export async function verifySessionToken(token: string, signingKeyB64: string, now: () => number = Date.now): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await importHmacKey(signingKeyB64);
    const payloadBytes = fromBase64Url(parts[0]);
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64Url(parts[1]), payloadBytes);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt * 1000 < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function getSession(request: Request, signingKeyB64: string): Promise<SessionPayload | null> {
  const header = request.headers.get("cookie");
  if (!header || !signingKeyB64) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      return verifySessionToken(pair.slice(eq + 1).trim(), signingKeyB64);
    }
  }
  return null;
}
