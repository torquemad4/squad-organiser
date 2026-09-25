export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_NAME: string;
  EMAIL_MODE: "smtp" | "dev";
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASS?: string;
  ADMIN_EMAILS?: string;
}

export interface User {
  id: number;
  email: string;
  name: string | null;
  naf_name: string | null;
  naf_number: string | null;
}

export interface PricedItem {
  key: string;
  label: string;
  /** Minor units, e.g. cents. */
  price: number;
}

export interface ExtraField {
  key: string;
  label: string;
  /** "items" is a priced tick-list; its value is the ticked item keys joined by commas. */
  type: "text" | "textarea" | "checkbox" | "select" | "items";
  required?: boolean;
  help?: string;
  options?: string[];
  items?: PricedItem[];
  currency?: string;
  /** Shown at the top of the field, e.g. the organisers' page describing the items. */
  link?: { href: string; label: string };
}

export interface Tournament {
  id: number;
  slug: string;
  name: string;
  location: string | null;
  dates: string | null;
  description: string | null;
  squad_size: number;
  extra_fields: string;
  ticket_price_cents: number | null;
  ticket_includes: string | null;
  /** Most squads allowed; null means no limit. */
  max_squads: number | null;
  status: "open" | "closed";
}

export interface Squad {
  id: number;
  tournament_id: number;
  captain_user_id: number;
  name: string | null;
  position: number;
  captain_name: string | null;
  captain_email: string;
}

/** An application joined with its applicant and squad placement. */
export interface Entry {
  application_id: number;
  user_id: number;
  email: string;
  name: string | null;
  naf_name: string | null;
  naf_number: string | null;
  extras: string;
  status: "active" | "withdrawn";
  created_at: string;
  updated_at: string;
  squad_id: number | null;
  paid_cents: number | null;
  paid_at: string | null;
}

export function extraFields(t: Tournament): ExtraField[] {
  return JSON.parse(t.extra_fields) as ExtraField[];
}

/** Tactics and Theatrics squads are X, then O, unless the captain renames them. */
const DEFAULT_SQUAD_NAMES = ["Tactics & Theatrics X", "Tactics & Theatrics O"];

export function squadName(s: Pick<Squad, "name" | "position">): string {
  return s.name?.trim() || DEFAULT_SQUAD_NAMES[s.position - 1] || `Squad ${s.position}`;
}

export async function findOrCreateUser(env: Env, email: string): Promise<User> {
  await env.DB.prepare("INSERT INTO users (email) VALUES (?) ON CONFLICT (email) DO NOTHING").bind(email).run();
  return (await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>())!;
}

export async function listTournaments(env: Env): Promise<Tournament[]> {
  const { results } = await env.DB.prepare("SELECT * FROM tournaments ORDER BY status = 'open' DESC, id DESC").all<Tournament>();
  return results;
}

export function getTournament(env: Env, slug: string): Promise<Tournament | null> {
  return env.DB.prepare("SELECT * FROM tournaments WHERE slug = ?").bind(slug).first<Tournament>();
}

export async function listSquads(env: Env, tournamentId: number): Promise<Squad[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.*, u.name AS captain_name, u.email AS captain_email
       FROM squads s JOIN users u ON u.id = s.captain_user_id
      WHERE s.tournament_id = ? ORDER BY s.position`,
  )
    .bind(tournamentId)
    .all<Squad>();
  return results;
}

export async function listEntries(env: Env, tournamentId: number): Promise<Entry[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id AS application_id, a.user_id, u.email, u.name, u.naf_name, u.naf_number,
            a.extras, a.status, a.created_at, a.updated_at, m.squad_id, a.paid_cents, a.paid_at
       FROM applications a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN squad_members m ON m.application_id = a.id
      WHERE a.tournament_id = ?
      ORDER BY a.created_at, a.id`,
  )
    .bind(tournamentId)
    .all<Entry>();
  return results;
}

export async function isCaptainAnywhere(env: Env, userId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM squads WHERE captain_user_id = ? LIMIT 1").bind(userId).first();
  return !!row;
}

/**
 * The first admin is the initial captain of every tournament. Their squad is created as soon
 * as they have an account, so they can draft before (or without) filing their own application.
 */
export async function ensureInitialCaptain(env: Env, tournamentId: number, firstAdminEmail: string | undefined) {
  if (!firstAdminEmail) return;
  await env.DB.prepare(
    `INSERT INTO squads (tournament_id, captain_user_id, position)
     SELECT ?, u.id, 1 FROM users u
      WHERE u.email = ?
        AND NOT EXISTS (SELECT 1 FROM squads WHERE tournament_id = ?)`,
  )
    .bind(tournamentId, firstAdminEmail, tournamentId)
    .run();
  await placeCaptainsInOwnSquads(env, tournamentId);
}

/**
 * A captain with an active application always sits in their own squad. Picks keep a seat
 * free for a captain who has not applied yet (see pickIntoSquad), so this never overfills.
 */
export async function placeCaptainsInOwnSquads(env: Env, tournamentId: number) {
  await env.DB.prepare(
    `INSERT INTO squad_members (application_id, squad_id, added_by)
     SELECT a.id, s.id, a.user_id FROM applications a
       JOIN squads s ON s.captain_user_id = a.user_id AND s.tournament_id = a.tournament_id
      WHERE a.tournament_id = ? AND a.status = 'active'
     ON CONFLICT (application_id) DO UPDATE SET squad_id = excluded.squad_id`,
  )
    .bind(tournamentId)
    .run();
}

/**
 * Adds an active, undrafted application to a squad if there is room. The captain's seat
 * counts as taken even before they apply. Returns false if the pick did not happen.
 */
export async function pickIntoSquad(env: Env, squadId: number, applicationId: number, byUserId: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO squad_members (application_id, squad_id, added_by)
     SELECT a.id, s.id, ?
       FROM applications a JOIN squads s ON s.tournament_id = a.tournament_id JOIN tournaments t ON t.id = s.tournament_id
      WHERE a.id = ? AND s.id = ? AND a.status = 'active'
        AND (SELECT COUNT(*) FROM squad_members m WHERE m.squad_id = s.id)
          + (SELECT CASE WHEN EXISTS (
                SELECT 1 FROM squad_members m JOIN applications ca ON ca.id = m.application_id
                 WHERE m.squad_id = s.id AND ca.user_id = s.captain_user_id) THEN 0 ELSE 1 END)
          < t.squad_size
     ON CONFLICT (application_id) DO NOTHING`,
  )
    .bind(byUserId, applicationId, squadId)
    .run();
  return res.meta.changes > 0;
}
