/**
 * Prometheus Worker: passkey auth, the agent API, and (through [assets]) the
 * studio itself. Only /api/* and /auth/* reach this code (run_worker_first);
 * every other path is served straight from ./dist.
 */
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { LIMITS, type AgentMode, type TurnRequest } from "../shared/protocol.ts";
import { buildSessionClearCookie, buildSessionCookie, getSession, issueSessionToken } from "./auth/session.ts";
import type { RpConfig } from "./do/studio.ts";
import type { AppEnv } from "./env.ts";

export { Studio } from "./do/studio.ts";
export { Gate } from "./do/gate.ts";
export { Atelier } from "./do/atelier.ts";

const MAX_TURN_BYTES = 1_500_000;
const MODES: AgentMode[] = ["lead", "follow", "watch"];

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

async function readJson<T>(request: Request, maxBytes = 64_000): Promise<T | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The rpID is the request host, as in mythosengine — so workers.dev and the custom domain each enrol their own passkey. */
const rpFor = (url: URL): RpConfig => ({ rpID: url.hostname, origin: url.origin });

/** State-changing requests must come from this origin (cookie is SameSite=Strict too; this is belt and braces). */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === url.origin;
}

/**
 * Local testing only: `DEV_BYPASS_AUTH=1` in .dev.vars signs every request in,
 * and only when the request is to localhost — a deployed Worker never sees a
 * localhost host, so the variable cannot open production even if set there.
 */
async function sessionFor(request: Request, env: AppEnv, url: URL) {
  if (env.DEV_BYPASS_AUTH === "1" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return { sessionId: "dev-local", issuedAt: 0, expiresAt: 0 };
  }
  return getSession(request, env.SESSION_SIGNING_KEY);
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/api/health") return json({ ok: true, model: env.GEMINI_MODEL });
    if (method === "POST" && !sameOrigin(request, url)) return json({ error: "bad_origin" }, 403);

    const studio = env.STUDIO.get(env.STUDIO.idFromName("studio"));
    const rp = rpFor(url);

    try {
      // ---- auth (no session needed) ----
      if (pathname === "/auth/status" && method === "GET") {
        const session = await sessionFor(request, env, url);
        const status = await studio.status();
        return json({ signedIn: session !== null, ...status, configured: Boolean(env.SESSION_SIGNING_KEY && env.ENROLLMENT_TOKEN) });
      }
      if (pathname === "/auth/passkey/register/begin" && method === "POST") {
        const body = await readJson<{ token?: string }>(request);
        const result = await studio.beginRegistration(rp, body?.token ?? "");
        if (result.kind === "enrollment_closed") return json({ error: "enrollment_closed" }, 410);
        if (result.kind === "invalid_token") return json({ error: "invalid_token" }, 401);
        if (result.kind === "not_configured") return json({ error: "enrollment_not_configured" }, 503);
        return json({ options: result.options, challengeId: result.challengeId });
      }
      if (pathname === "/auth/passkey/register/finish" && method === "POST") {
        const body = await readJson<{ challengeId?: string; response?: RegistrationResponseJSON; label?: string }>(request);
        if (!body?.challengeId || !body.response) return json({ error: "invalid_request" }, 400);
        const result = await studio.finishRegistration(rp, body.challengeId, body.response, body.label ?? url.hostname);
        return result.kind === "ok" ? json({ ok: true }) : json({ error: result.kind }, 400);
      }
      if (pathname === "/auth/passkey/authenticate/begin" && method === "POST") {
        return json(await studio.beginAuthentication(rp));
      }
      if (pathname === "/auth/passkey/authenticate/finish" && method === "POST") {
        const body = await readJson<{ challengeId?: string; response?: AuthenticationResponseJSON }>(request);
        if (!body?.challengeId || !body.response) return json({ error: "invalid_request" }, 400);
        const result = await studio.finishAuthentication(rp, body.challengeId, body.response);
        if (result.kind !== "ok") return json({ error: result.kind }, 401);
        const token = await issueSessionToken(crypto.randomUUID(), env.SESSION_SIGNING_KEY);
        return json({ ok: true }, 200, { "set-cookie": buildSessionCookie(token) });
      }
      if (pathname === "/auth/logout" && method === "POST") {
        return json({ ok: true }, 200, { "set-cookie": buildSessionClearCookie() });
      }

      // ---- everything below needs a session ----
      const session = await sessionFor(request, env, url);
      if (!session) return json({ error: "unauthorized" }, 401);
      const gate = env.GATE.get(env.GATE.idFromName("gemini"));
      // One Atelier per (signed-in session, browser tab): a tab id alone could be replayed by another session.
      const atelierFor = (tab: string) => env.ATELIER.get(env.ATELIER.idFromName(`${session.sessionId}:${tab}`));

      if (pathname === "/api/agent/budget" && method === "GET") return json(await gate.status());

      if (pathname === "/api/agent/turn" && method === "POST") {
        const body = await readJson<TurnRequest>(request, MAX_TURN_BYTES);
        const problem = validateTurn(body);
        if (problem) return json({ ok: false, error: problem, actions: [] }, 400);
        return json(await atelierFor(body!.sessionId).turn(body!));
      }

      if (pathname === "/api/session/end" && method === "POST") {
        const body = await readJson<{ sessionId?: string }>(request);
        if (body?.sessionId && /^[\w-]{8,64}$/.test(body.sessionId)) await atelierFor(body.sessionId).end();
        return json({ ok: true });
      }


      return json({ error: "not_found" }, 404);
    } catch (cause) {
      console.error("request failed", pathname, cause);
      return json({ error: "internal", detail: cause instanceof Error ? cause.message : String(cause) }, 500);
    }
  },
} satisfies ExportedHandler<AppEnv>;

function validateTurn(body: TurnRequest | null): string | null {
  if (!body) return "invalid_json_or_too_large";
  if (typeof body.sessionId !== "string" || !/^[\w-]{8,64}$/.test(body.sessionId)) return "bad_session_id";
  if (body.trigger !== "human" && body.trigger !== "ambient") return "bad_trigger";
  if (!MODES.includes(body.mode)) return "bad_mode";
  const o = body.observation;
  if (!o || typeof o.sheet !== "string" || o.sheet.length > LIMITS.sheetB64 || o.sheet.length < 100) return "bad_sheet";
  if (typeof o.thumb !== "string" || o.thumb.length > LIMITS.thumbB64) return "bad_thumb";
  if (!o.geometry || !Array.isArray(o.strokes)) return "bad_observation";
  if (body.message !== undefined && (typeof body.message !== "string" || body.message.length > LIMITS.chatChars)) return "bad_message";
  o.strokes = o.strokes.slice(-LIMITS.strokesPerObservation);
  return null;
}
