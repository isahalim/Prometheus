/**
 * Studio — the singleton that holds who may sculpt.
 *
 * Passkeys: the same enrollment-token + WebAuthn flow as mythosengine
 * (src/server/auth/webauthn.ts there), moved from D1 into this object's own
 * SQLite so the deploy token needs no D1 permission. The token is the same
 * value; the passkeys themselves cannot be shared, because a WebAuthn
 * credential is bound to its rpID (the host), so each host enrols its own.
 *
 * (It once also held a long-term memory block; the agent rarely used it, so
 * it was removed and the table is dropped on first start.)
 */
import { DurableObject } from "cloudflare:workers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AppEnv } from "../env.ts";

const RP_NAME = "Prometheus";
const OPERATOR_USER_ID = new Uint8Array(new TextEncoder().encode("operator"));
/** workers.dev + the custom domain + one spare. Deleting a row reopens a slot. */
export const MAX_REGISTERED_CREDENTIALS = 3;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface RpConfig {
  rpID: string;
  origin: string;
}

interface CredentialRow {
  credential_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string | null;
  [key: string]: SqlStorageValue;
}

export type BeginRegistration =
  | { kind: "ok"; options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }
  | { kind: "enrollment_closed" }
  | { kind: "invalid_token" }
  | { kind: "not_configured" };

export type FinishResult = { kind: "ok" } | { kind: "invalid_challenge" | "unknown_credential" | "verification_failed" | "counter_regression" };

export class Studio extends DurableObject<AppEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        credential_id TEXT PRIMARY KEY,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        purpose TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
      );
      DROP TABLE IF EXISTS memory;
    `);
  }

  private credentials(): CredentialRow[] {
    return this.sql.exec<CredentialRow>("SELECT credential_id, public_key, counter, transports FROM credentials").toArray();
  }

  private storeChallenge(challenge: string, purpose: "register" | "authenticate"): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec("DELETE FROM challenges WHERE expires_at < ? OR consumed = 1", now);
    this.sql.exec("INSERT INTO challenges (id, challenge, purpose, expires_at) VALUES (?, ?, ?, ?)", id, challenge, purpose, now + CHALLENGE_TTL_MS);
    return id;
  }

  /** Single UPDATE ... RETURNING, so a challenge can be consumed exactly once. */
  private consumeChallenge(id: string, purpose: "register" | "authenticate"): string | null {
    const rows = this.sql
      .exec<{ challenge: string }>(
        "UPDATE challenges SET consumed = 1 WHERE id = ? AND purpose = ? AND consumed = 0 AND expires_at > ? RETURNING challenge",
        id,
        purpose,
        Date.now(),
      )
      .toArray();
    return rows[0]?.challenge ?? null;
  }

  status(): { credentialCount: number; enrollmentOpen: boolean; maxCredentials: number } {
    const count = this.credentials().length;
    return { credentialCount: count, enrollmentOpen: count < MAX_REGISTERED_CREDENTIALS, maxCredentials: MAX_REGISTERED_CREDENTIALS };
  }

  async beginRegistration(rp: RpConfig, providedToken: string): Promise<BeginRegistration> {
    const existing = this.credentials();
    if (existing.length >= MAX_REGISTERED_CREDENTIALS) return { kind: "enrollment_closed" };
    const expected = (this.env.ENROLLMENT_TOKEN ?? "").trim();
    if (expected === "") return { kind: "not_configured" };
    // Trimmed on both sides, as in mythosengine: a secret piped in with a
    // trailing newline would otherwise never match what a human pastes.
    if (providedToken.trim() !== expected) return { kind: "invalid_token" };

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.rpID,
      userName: "operator",
      userID: OPERATOR_USER_ID,
      excludeCredentials: existing.map((c) => ({ id: c.credential_id })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return { kind: "ok", options, challengeId: this.storeChallenge(options.challenge, "register") };
  }

  async finishRegistration(rp: RpConfig, challengeId: string, response: RegistrationResponseJSON, label: string): Promise<FinishResult> {
    const challenge = this.consumeChallenge(challengeId, "register");
    if (challenge === null) return { kind: "invalid_challenge" };
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      });
    } catch {
      return { kind: "verification_failed" };
    }
    if (!verification.verified) return { kind: "verification_failed" };
    const { credential } = verification.registrationInfo;
    this.sql.exec(
      "INSERT INTO credentials (credential_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      credential.id,
      credential.publicKey.slice().buffer,
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      label.slice(0, 64) || "passkey",
      new Date().toISOString(),
    );
    return { kind: "ok" };
  }

  async beginAuthentication(rp: RpConfig): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }> {
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      allowCredentials: this.credentials().map((c) => ({
        id: c.credential_id,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      })),
      userVerification: "required",
    });
    return { options, challengeId: this.storeChallenge(options.challenge, "authenticate") };
  }

  async finishAuthentication(rp: RpConfig, challengeId: string, response: AuthenticationResponseJSON): Promise<FinishResult> {
    const challenge = this.consumeChallenge(challengeId, "authenticate");
    if (challenge === null) return { kind: "invalid_challenge" };
    const stored = this.sql
      .exec<CredentialRow>("SELECT credential_id, public_key, counter, transports FROM credentials WHERE credential_id = ?", response.id)
      .toArray()[0];
    if (!stored) return { kind: "unknown_credential" };

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: stored.credential_id,
          publicKey: new Uint8Array(stored.public_key),
          counter: stored.counter,
          transports: stored.transports ? JSON.parse(stored.transports) : undefined,
        },
        requireUserVerification: true,
      });
    } catch {
      return { kind: "verification_failed" };
    }
    if (!verification.verified) return { kind: "verification_failed" };

    // Counter regression = possibly cloned authenticator (some report a constant 0).
    const { newCounter } = verification.authenticationInfo;
    if (stored.counter !== 0 && newCounter !== 0 && newCounter <= stored.counter) return { kind: "counter_regression" };
    this.sql.exec("UPDATE credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?", newCounter, new Date().toISOString(), stored.credential_id);
    return { kind: "ok" };
  }
}
