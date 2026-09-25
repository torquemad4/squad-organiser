// Email-link sign-in. Tokens are random 256-bit values; only their SHA-256 hash is stored.

import type { Env, User } from "./db";

export const LINK_TTL_MS = 30 * 60 * 1000;
export const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const MAX_LINKS_PER_HOUR = 5;
const COOKIE = "sid";

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type LinkPayload =
  | { kind: "login"; next?: string }
  | {
      kind: "apply";
      tournamentId: number;
      profile: { name: string; naf_name: string; naf_number: string };
      extras: Record<string, string>;
    };

/** Returns a new sign-in token, or null when this email has asked for too many recently. */
export async function createLoginToken(env: Env, email: string, payload: LinkPayload): Promise<string | null> {
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?")
    .bind(email, now - 60 * 60 * 1000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_LINKS_PER_HOUR) return null;

  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO login_tokens (token_hash, email, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(await sha256(token), email, JSON.stringify(payload), now + LINK_TTL_MS, now)
    .run();
  return token;
}

/** Marks a token used and returns its email and payload, or null if it is unknown, used or expired. */
export async function consumeLoginToken(env: Env, token: string): Promise<{ email: string; payload: LinkPayload } | null> {
  const now = Date.now();
  // The UPDATE only matches an unused, unexpired token, so two clicks cannot both succeed.
  const row = await env.DB.prepare(
    "UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email, payload",
  )
    .bind(now, await sha256(token), now)
    .first<{ email: string; payload: string }>();
  if (!row) return null;
  return { email: row.email, payload: JSON.parse(row.payload) as LinkPayload };
}

export async function peekLoginToken(env: Env, token: string): Promise<{ email: string } | null> {
  return env.DB.prepare("SELECT email FROM login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(await sha256(token), Date.now())
    .first<{ email: string }>();
}

export async function createSession(env: Env, userId: number): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now + SESSION_TTL_MS, now)
    .run();
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function sessionToken(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

export async function currentUser(env: Env, req: Request): Promise<User | null> {
  const token = sessionToken(req);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(token), Date.now())
    .first<User>();
}

export async function destroySession(env: Env, req: Request): Promise<string> {
  const token = sessionToken(req);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(env: Env, user: User | null): boolean {
  return !!user && adminEmails(env).includes(user.email.toLowerCase());
}
