import {
  adminEmails,
  consumeLoginToken,
  createLoginToken,
  createSession,
  currentUser,
  destroySession,
  isAdmin,
  peekLoginToken,
  type LinkPayload,
} from "./auth";
import {
  ensureInitialCaptain,
  extraFields,
  findOrCreateUser,
  getTournament,
  isCaptainAnywhere,
  listEntries,
  listSquads,
  listTournaments,
  pickIntoSquad,
  placeCaptainsInOwnSquads,
  squadName,
  type Entry,
  type Env,
  type ExtraField,
  type Squad,
  type Tournament,
  type User,
} from "./db";
import { sendEmail } from "./email";
import { Html, html, page, type Nav } from "./html";

interface Ctx {
  env: Env;
  req: Request;
  url: URL;
  user: User | null;
  admin: boolean;
  nav: Nav;
}

const MESSAGES: Record<string, string> = {
  applied: "You're in the pool. The captains can now draft you.",
  updated: "Your sign-up has been updated.",
  withdrawn: "You've withdrawn from this tournament.",
  "captain-cannot-withdraw": "You're a captain for this tournament. Ask an admin to remove your squad before withdrawing.",
  picked: "Drafted.",
  "pick-failed": "That pick didn't go through: your squad is full or someone else drafted them first.",
  released: "Returned to the pool.",
  nominated: "New captain nominated. Their squad is ready to draft.",
  "nominate-not-yet": "There aren't enough people in the pool for another squad yet.",
  "nominate-failed": "That person can't be nominated (already a captain, or no longer signed up).",
  renamed: "Squad renamed.",
  "squad-removed": "Squad removed; its players are back in the pool.",
  "status-changed": "Tournament status updated.",
  "link-invalid": "That sign-in link has expired or has already been used. Request a new one below.",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (err) {
      console.error(err);
      return new Response("Something went wrong.", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  if (method === "POST") {
    // Cookies are SameSite=Lax; also refuse cross-site form posts outright.
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) return new Response("Cross-site request refused.", { status: 403 });
  }

  const user = await currentUser(env, req);
  const admin = isAdmin(env, user);
  const nav: Nav = {
    appName: env.APP_NAME,
    user,
    isAdmin: admin,
    isCaptain: user ? await isCaptainAnywhere(env, user.id) : false,
  };
  const c: Ctx = { env, req, url, user, admin, nav };
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/" && method === "GET") return home(c);
  if (path === "/login" && method === "GET") return loginForm(c);
  if (path === "/login" && method === "POST") return loginSubmit(c);
  if (path === "/auth" && method === "GET") return authConfirm(c);
  if (path === "/auth" && method === "POST") return authComplete(c);
  if (path === "/logout" && method === "POST") return logout(c);
  if (path === "/me" && method === "GET") return me(c);
  if (path === "/draft" && method === "GET") return draftIndex(c);
  if (path === "/__dev/outbox" && method === "GET" && env.EMAIL_MODE === "dev") return devOutbox(c);

  const m = path.match(/^\/t\/([a-z0-9-]+)(?:\/(.+))?$/);
  if (m) {
    const t = await getTournament(env, m[1]);
    if (!t) return notFound(c);
    await ensureInitialCaptain(env, t.id, adminEmails(env)[0]);
    const sub = m[2] ?? "";
    if (sub === "" && method === "GET") return tournamentPage(c, t);
    if (sub === "apply" && method === "POST") return applySubmit(c, t);
    if (sub === "withdraw" && method === "POST") return withdraw(c, t);
    if (sub === "draft" && method === "GET") return draftPage(c, t);
    if (sub === "export.csv" && method === "GET") return exportCsv(c, t);
    if (sub.startsWith("draft/") && method === "POST") return draftAction(c, t, sub.slice(6));
    if (sub === "status" && method === "POST") return setStatus(c, t);
  }
  return notFound(c);
}

// ---------- helpers ----------

function redirect(to: string, cookie?: string): Response {
  const headers = new Headers({ location: to });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function flash(c: Ctx): Html | null {
  const key = c.url.searchParams.get("msg");
  const text = key ? MESSAGES[key] : null;
  if (!text) return null;
  const error = /failed|cannot|not-yet|invalid/.test(key!);
  return html`<p class="notice ${error ? "error" : ""}" role="status">${text}</p>`;
}

function notFound(c: Ctx): Response {
  return page("Not found", c.nav, html`<h1>Not found</h1><p><a href="/">Back to tournaments</a></p>`, 404);
}

function forbidden(c: Ctx): Response {
  return page("Not allowed", c.nav, html`<h1>Not allowed</h1><p>This page is for captains.</p>`, 403);
}

function requireLogin(c: Ctx): Response | null {
  if (c.user) return null;
  return redirect(`/login?next=${encodeURIComponent(c.url.pathname + c.url.search)}`);
}

function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/me";
}

function displayName(e: { name: string | null; email: string }): string {
  return e.name?.trim() || e.email;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(v: unknown): string | null {
  const e = String(v ?? "").trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

function formatDate(sqlite: string): string {
  const d = new Date(sqlite.replace(" ", "T") + "Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ---------- application form ----------

interface ApplicationInput {
  email: string | null;
  profile: { name: string; naf_name: string; naf_number: string };
  extras: Record<string, string>;
}

function readApplication(form: FormData, fields: ExtraField[]): { input: ApplicationInput; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const str = (k: string) => String(form.get(k) ?? "").trim();

  const profile = { name: str("name"), naf_name: str("naf_name"), naf_number: str("naf_number") };
  if (!profile.name) errors.name = "Enter your name.";
  else if (profile.name.length > 100) errors.name = "That's too long.";
  if (!profile.naf_name) errors.naf_name = "Enter your NAF name.";
  else if (profile.naf_name.length > 60) errors.naf_name = "That's too long.";
  if (!/^\d{1,7}$/.test(profile.naf_number)) errors.naf_number = "Enter your NAF number (digits only).";

  const extras: Record<string, string> = {};
  for (const f of fields) {
    let v = str(`x_${f.key}`);
    if (f.type === "checkbox") v = v ? "yes" : "";
    if (f.type === "select" && v && !(f.options ?? []).includes(v)) v = "";
    if (v.length > 2000) errors[`x_${f.key}`] = "That's too long.";
    if (f.required && !v) errors[`x_${f.key}`] = f.type === "checkbox" ? "Please tick this box." : `Please fill in ${f.label.toLowerCase()}.`;
    extras[f.key] = v;
  }

  const email = form.has("email") ? normaliseEmail(form.get("email")) : null;
  if (form.has("email") && !email) errors.email = "Enter a valid email address.";
  return { input: { email, profile, extras }, errors };
}

async function saveApplication(env: Env, user: User, t: Tournament, input: Omit<ApplicationInput, "email">): Promise<"applied" | "updated"> {
  const existing = await env.DB.prepare("SELECT status FROM applications WHERE tournament_id = ? AND user_id = ?")
    .bind(t.id, user.id)
    .first<{ status: string }>();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET name = ?, naf_name = ?, naf_number = ? WHERE id = ?").bind(
      input.profile.name,
      input.profile.naf_name,
      input.profile.naf_number,
      user.id,
    ),
    env.DB.prepare(
      `INSERT INTO applications (tournament_id, user_id, extras) VALUES (?, ?, ?)
       ON CONFLICT (tournament_id, user_id)
       DO UPDATE SET extras = excluded.extras, status = 'active', updated_at = datetime('now')`,
    ).bind(t.id, user.id, JSON.stringify(input.extras)),
  ]);
  await ensureInitialCaptain(env, t.id, adminEmails(env)[0]);
  await placeCaptainsInOwnSquads(env, t.id);
  return existing?.status === "active" ? "updated" : "applied";
}

function field(
  name: string,
  label: string,
  opts: { value?: string; error?: string; required?: boolean; help?: string; type?: string; autocomplete?: string; inputmode?: string },
): Html {
  const id = `f_${name}`;
  return html`<div>
    <label for="${id}">${label} ${opts.required ? null : html`<span class="req">(optional)</span>`}</label>
    ${opts.help ? html`<p class="help">${opts.help}</p>` : null}
    <input id="${id}" name="${name}" type="${opts.type ?? "text"}" value="${opts.value ?? ""}"
      ${opts.required ? html`required` : null}
      ${opts.autocomplete ? html`autocomplete="${opts.autocomplete}"` : null}
      ${opts.inputmode ? html`inputmode="${opts.inputmode}"` : null}>
    ${opts.error ? html`<p class="help" role="alert"><strong>${opts.error}</strong></p>` : null}
  </div>`;
}

function extraInput(f: ExtraField, value: string, error?: string): Html {
  const name = `x_${f.key}`;
  const id = `f_${name}`;
  const label = html`${f.label} ${f.required ? null : html`<span class="req">(optional)</span>`}`;
  const help = f.help ? html`<p class="help">${f.help}</p>` : null;
  const err = error ? html`<p class="help" role="alert"><strong>${error}</strong></p>` : null;
  if (f.type === "checkbox") {
    return html`<div><label class="check"><input type="checkbox" name="${name}" value="yes" ${value ? html`checked` : null}> ${label}</label>${help}${err}</div>`;
  }
  if (f.type === "select") {
    return html`<div><label for="${id}">${label}</label>${help}
      <select id="${id}" name="${name}" ${f.required ? html`required` : null}>
        <option value="">Choose…</option>
        ${(f.options ?? []).map((o) => html`<option ${o === value ? html`selected` : null}>${o}</option>`)}
      </select>${err}</div>`;
  }
  if (f.type === "textarea") {
    return html`<div><label for="${id}">${label}</label>${help}
      <textarea id="${id}" name="${name}" ${f.required ? html`required` : null}>${value}</textarea>${err}</div>`;
  }
  return field(name, f.label, { value, error, required: f.required, help: f.help });
}

// ---------- pages ----------

async function home(c: Ctx): Promise<Response> {
  const tournaments = await listTournaments(c.env);
  const counts = await c.env.DB.prepare(
    "SELECT tournament_id, COUNT(*) AS n FROM applications WHERE status = 'active' GROUP BY tournament_id",
  ).all<{ tournament_id: number; n: number }>();
  const countOf = (id: number) => counts.results.find((r) => r.tournament_id === id)?.n ?? 0;

  return page(
    "Tournaments",
    { ...c.nav, active: "tournaments" },
    html`<h1>Tournaments</h1>
    <p class="lede muted">Pick a tournament to sign up for. Captains draft squads from everyone who signs up.</p>
    ${tournaments.length === 0 ? html`<p>No tournaments yet.</p>` : null}
    ${tournaments.map(
      (t) => html`<a class="card link" href="/t/${t.slug}">
        <div class="meta">${[t.location, t.dates].filter(Boolean).join(" · ")}${t.status === "closed" ? " · Sign-ups closed" : ""}</div>
        <h3>${t.name}</h3>
        <div class="muted small">Squads of ${t.squad_size} · <span class="count">${countOf(t.id)}</span> signed up</div>
      </a>`,
    )}`,
  );
}

async function tournamentPage(c: Ctx, t: Tournament, form?: { input: ApplicationInput; errors: Record<string, string> }): Promise<Response> {
  const fields = extraFields(t);
  const [entries, squads] = await Promise.all([listEntries(c.env, t.id), listSquads(c.env, t.id)]);
  const active = entries.filter((e) => e.status === "active");
  const mine = c.user ? entries.find((e) => e.user_id === c.user!.id) : undefined;
  const myExtras: Record<string, string> = mine ? JSON.parse(mine.extras) : {};
  const isCaptainHere = !!c.user && squads.some((s) => s.captain_user_id === c.user!.id);

  const v = form?.input;
  const err = form?.errors ?? {};
  const profile = v?.profile ?? { name: c.user?.name ?? "", naf_name: c.user?.naf_name ?? "", naf_number: c.user?.naf_number ?? "" };
  const extras = v?.extras ?? myExtras;
  const hasApplied = mine?.status === "active";

  const formHtml =
    t.status === "closed"
      ? html`<p class="notice">Sign-ups for this tournament are closed.</p>`
      : html`<form method="post" action="/t/${t.slug}/apply" class="stack" novalidate>
      <fieldset>
        ${c.user
          ? html`<div><label>Email</label><p class="muted" style="margin:0">${c.user.email}</p></div>`
          : field("email", "Email", { value: v?.email ?? "", error: err.email, required: true, type: "email", autocomplete: "email",
              help: "We'll email you a link to confirm your sign-up." })}
        ${field("name", "Name", { value: profile.name, error: err.name, required: true, autocomplete: "name" })}
        ${field("naf_name", "NAF name", { value: profile.naf_name, error: err.naf_name, required: true })}
        ${field("naf_number", "NAF number", { value: profile.naf_number, error: err.naf_number, required: true, inputmode: "numeric" })}
      </fieldset>
      ${fields.length
        ? html`<fieldset><legend>For this tournament</legend>${fields.map((f) => extraInput(f, extras[f.key] ?? "", err[`x_${f.key}`]))}</fieldset>`
        : null}
      <div class="actions"><button type="submit">${hasApplied ? "Update my sign-up" : c.user ? "Sign up" : "Sign up and email me a link"}</button></div>
    </form>`;

  return page(
    t.name,
    { ...c.nav, active: "tournaments" },
    html`${flash(c)}
    <div class="meta">${[t.location, t.dates].filter(Boolean).join(" · ")}</div>
    <h1>${t.name}</h1>
    ${t.description ? html`<p class="lede">${t.description}</p>` : null}
    <p class="muted small"><span class="count">${active.length}</span> signed up · ${squads.length} ${squads.length === 1 ? "squad" : "squads"} of ${t.squad_size}
      ${isCaptainHere || c.admin ? html` · <a href="/t/${t.slug}/draft">Open the draft</a>` : null}</p>
    ${hasApplied ? html`<p class="notice">You're signed up. Change anything below and save.</p>` : null}
    <h2>${hasApplied ? "Your sign-up" : "Sign up"}</h2>
    ${formHtml}
    ${hasApplied && !isCaptainHere
      ? html`<h2>Can't make it?</h2>
        <form method="post" action="/t/${t.slug}/withdraw" data-confirm="Withdraw from ${t.name}?">
          <button class="ghost">Withdraw</button></form>`
      : null}
    ${c.admin
      ? html`<h2>Admin</h2><form method="post" action="/t/${t.slug}/status" class="actions">
          <input type="hidden" name="status" value="${t.status === "open" ? "closed" : "open"}">
          <button class="ghost">${t.status === "open" ? "Close sign-ups" : "Reopen sign-ups"}</button></form>`
      : null}`,
    form ? 400 : 200,
  );
}

async function applySubmit(c: Ctx, t: Tournament): Promise<Response> {
  if (t.status !== "open") return redirect(`/t/${t.slug}`);
  const form = await c.req.formData();
  if (c.user) form.delete("email");
  else if (!form.has("email")) form.set("email", "");
  const parsed = readApplication(form, extraFields(t));
  if (Object.keys(parsed.errors).length) return tournamentPage(c, t, parsed);

  if (c.user) {
    const result = await saveApplication(c.env, c.user, t, parsed.input);
    return redirect(`/t/${t.slug}?msg=${result}`);
  }

  // Not signed in: park the application in a sign-in link; it's saved when the link is used.
  const email = parsed.input.email!;
  const payload: LinkPayload = { kind: "apply", tournamentId: t.id, profile: parsed.input.profile, extras: parsed.input.extras };
  const token = await createLoginToken(c.env, email, payload);
  if (token) {
    await sendEmail(c.env, {
      to: email,
      subject: `Confirm your sign-up: ${t.name}`,
      text: `Hi ${parsed.input.profile.name},

Click this link to confirm your sign-up for ${t.name} with ${c.env.APP_NAME}:

${c.url.origin}/auth?token=${token}

The link works once and expires in 30 minutes. If you didn't ask for this, ignore this email.`,
    });
  }
  return checkEmail(c, email, !token);
}

function checkEmail(c: Ctx, email: string, rateLimited: boolean): Response {
  return page(
    "Check your email",
    c.nav,
    rateLimited
      ? html`<h1>Too many links</h1><p>We've sent several links to ${email} in the last hour. Use the most recent one, or try again later.</p>`
      : html`<h1>Check your email</h1>
        <p class="lede">We've sent a link to <strong>${email}</strong>. Open it on this device to finish.</p>
        <p class="muted small">It expires in 30 minutes. Nothing there? Check spam, or <a href="/login">request a new link</a>.</p>`,
  );
}

async function withdraw(c: Ctx, t: Tournament): Promise<Response> {
  const needLogin = requireLogin(c);
  if (needLogin) return needLogin;
  const captain = await c.env.DB.prepare("SELECT 1 FROM squads WHERE tournament_id = ? AND captain_user_id = ?")
    .bind(t.id, c.user!.id)
    .first();
  if (captain) return redirect(`/t/${t.slug}?msg=captain-cannot-withdraw`);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM squad_members WHERE application_id = (SELECT id FROM applications WHERE tournament_id = ? AND user_id = ?)",
    ).bind(t.id, c.user!.id),
    c.env.DB.prepare(
      "UPDATE applications SET status = 'withdrawn', updated_at = datetime('now') WHERE tournament_id = ? AND user_id = ?",
    ).bind(t.id, c.user!.id),
  ]);
  return redirect(`/me?msg=withdrawn`);
}

async function setStatus(c: Ctx, t: Tournament): Promise<Response> {
  if (!c.admin) return forbidden(c);
  const status = String((await c.req.formData()).get("status"));
  if (status !== "open" && status !== "closed") return redirect(`/t/${t.slug}`);
  await c.env.DB.prepare("UPDATE tournaments SET status = ? WHERE id = ?").bind(status, t.id).run();
  return redirect(`/t/${t.slug}?msg=status-changed`);
}

// ---------- sign-in ----------

function loginForm(c: Ctx, error?: string): Response {
  const next = c.url.searchParams.get("next") ?? "";
  return page(
    "Sign in",
    c.nav,
    html`${flash(c)}<h1>Sign in</h1>
    <p class="lede muted">No passwords. Enter your email and we'll send you a sign-in link.</p>
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="next" value="${next}">
      ${field("email", "Email", { required: true, type: "email", autocomplete: "email", error })}
      <div class="actions"><button>Email me a link</button></div>
    </form>`,
    error ? 400 : 200,
  );
}

async function loginSubmit(c: Ctx): Promise<Response> {
  const form = await c.req.formData();
  const email = normaliseEmail(form.get("email"));
  if (!email) return loginForm(c, "Enter a valid email address.");
  const next = safeNext(String(form.get("next") ?? ""));
  const token = await createLoginToken(c.env, email, { kind: "login", next });
  if (token) {
    await sendEmail(c.env, {
      to: email,
      subject: `Your ${c.env.APP_NAME} sign-in link`,
      text: `Click this link to sign in to ${c.env.APP_NAME}:

${c.url.origin}/auth?token=${token}

The link works once and expires in 30 minutes. If you didn't ask for this, ignore this email.`,
    });
  }
  return checkEmail(c, email, !token);
}

// Mail scanners fetch links in emails, so GET only shows a button; the POST uses the token.
async function authConfirm(c: Ctx): Promise<Response> {
  const token = c.url.searchParams.get("token") ?? "";
  const row = token ? await peekLoginToken(c.env, token) : null;
  if (!row) return redirect("/login?msg=link-invalid");
  return page(
    "Confirm",
    c.nav,
    html`<h1>Continue as ${row.email}</h1>
    <form method="post" action="/auth" class="actions">
      <input type="hidden" name="token" value="${token}">
      <button>Continue</button>
    </form>`,
  );
}

async function authComplete(c: Ctx): Promise<Response> {
  const token = String((await c.req.formData()).get("token") ?? "");
  const consumed = token ? await consumeLoginToken(c.env, token) : null;
  if (!consumed) return redirect("/login?msg=link-invalid");

  const user = await findOrCreateUser(c.env, consumed.email);
  const cookie = await createSession(c.env, user.id);
  const p = consumed.payload;

  if (p.kind === "apply") {
    const t = await c.env.DB.prepare("SELECT * FROM tournaments WHERE id = ?").bind(p.tournamentId).first<Tournament>();
    if (!t) return redirect("/", cookie);
    if (t.status !== "open") return redirect(`/t/${t.slug}`, cookie);
    const result = await saveApplication(c.env, user, t, { profile: p.profile, extras: p.extras });
    return redirect(`/t/${t.slug}?msg=${result}`, cookie);
  }
  return redirect(safeNext(p.next), cookie);
}

async function logout(c: Ctx): Promise<Response> {
  return redirect("/", await destroySession(c.env, c.req));
}

// ---------- my sign-ups ----------

async function me(c: Ctx): Promise<Response> {
  const needLogin = requireLogin(c);
  if (needLogin) return needLogin;
  const { results } = await c.env.DB.prepare(
    `SELECT t.slug, t.name, t.location, t.dates, a.status, a.created_at,
            s.name AS squad_name, s.position AS squad_position, cu.name AS captain_name, cu.email AS captain_email,
            (SELECT 1 FROM squads x WHERE x.tournament_id = t.id AND x.captain_user_id = a.user_id) AS is_captain
       FROM applications a
       JOIN tournaments t ON t.id = a.tournament_id
       LEFT JOIN squad_members m ON m.application_id = a.id
       LEFT JOIN squads s ON s.id = m.squad_id
       LEFT JOIN users cu ON cu.id = s.captain_user_id
      WHERE a.user_id = ?
      ORDER BY a.created_at DESC`,
  )
    .bind(c.user!.id)
    .all<{
      slug: string; name: string; location: string | null; dates: string | null; status: string; created_at: string;
      squad_name: string | null; squad_position: number | null; captain_name: string | null; captain_email: string | null; is_captain: number | null;
    }>();

  return page(
    "My sign-ups",
    { ...c.nav, active: "me" },
    html`${flash(c)}<h1>My sign-ups</h1>
    <p class="muted">Signed in as ${c.user!.email}</p>
    ${results.length === 0 ? html`<p>You haven't signed up for anything yet. <a href="/">See tournaments</a>.</p>` : null}
    ${results.map((r) => {
      let state: Html;
      if (r.status === "withdrawn") state = html`<span class="tag">Withdrawn</span>`;
      else if (r.is_captain) state = html`<span class="tag">Captain</span> of ${squadName({ name: r.squad_name, position: r.squad_position ?? 1 })}`;
      else if (r.squad_position)
        state = html`<span class="tag">Drafted</span> ${squadName({ name: r.squad_name, position: r.squad_position })} · captain ${r.captain_name || r.captain_email}`;
      else state = html`<span class="tag">In the pool</span> waiting to be drafted`;
      return html`<a class="card link" href="/t/${r.slug}">
        <div class="meta">${[r.location, r.dates].filter(Boolean).join(" · ")}</div>
        <h3>${r.name}</h3>
        <div class="small">${state}</div>
      </a>`;
    })}`,
  );
}

// ---------- draft ----------

async function captainSquad(c: Ctx, t: Tournament): Promise<Squad | undefined> {
  if (!c.user) return undefined;
  return (await listSquads(c.env, t.id)).find((s) => s.captain_user_id === c.user!.id);
}

async function draftIndex(c: Ctx): Promise<Response> {
  const needLogin = requireLogin(c);
  if (needLogin) return needLogin;
  const { results } = await c.env.DB.prepare(
    c.admin
      ? "SELECT * FROM tournaments ORDER BY id DESC"
      : "SELECT t.* FROM tournaments t JOIN squads s ON s.tournament_id = t.id WHERE s.captain_user_id = ? ORDER BY t.id DESC",
  )
    .bind(...(c.admin ? [] : [c.user!.id]))
    .all<Tournament>();
  if (results.length === 1) return redirect(`/t/${results[0].slug}/draft`);
  return page(
    "Draft",
    { ...c.nav, active: "draft" },
    html`<h1>Draft</h1>
    ${results.length === 0 ? html`<p>You're not a captain for any tournament.</p>` : null}
    ${results.map((t) => html`<a class="card link" href="/t/${t.slug}/draft"><h3>${t.name}</h3></a>`)}`,
  );
}

function canNominate(activeCount: number, squadCount: number, size: number): boolean {
  return squadCount === 0 || activeCount > squadCount * size;
}

async function draftPage(c: Ctx, t: Tournament): Promise<Response> {
  const needLogin = requireLogin(c);
  if (needLogin) return needLogin;
  const [squads, entries] = await Promise.all([listSquads(c.env, t.id), listEntries(c.env, t.id)]);
  const mySquad = squads.find((s) => s.captain_user_id === c.user!.id);
  if (!mySquad && !c.admin) return forbidden(c);

  const fields = extraFields(t);
  const active = entries.filter((e) => e.status === "active");
  const pool = active.filter((e) => e.squad_id === null);
  const captainIds = new Set(squads.map((s) => s.captain_user_id));
  const membersOf = (s: Squad) => active.filter((e) => e.squad_id === s.id);
  const seatsUsed = (s: Squad) => {
    const members = membersOf(s);
    return members.length + (members.some((e) => e.user_id === s.captain_user_id) ? 0 : 1);
  };
  const myRoom = mySquad ? t.squad_size - seatsUsed(mySquad) : 0;
  const nominate = canNominate(active.length, squads.length, t.squad_size);

  const squadCard = (s: Squad) => {
    const mine = s.id === mySquad?.id;
    const members = membersOf(s);
    const captainApplied = members.some((e) => e.user_id === s.captain_user_id);
    return html`<section class="card squad ${mine ? "mine" : ""}">
      <h3><span>${squadName(s)}</span><span class="small count">${seatsUsed(s)}/${t.squad_size}</span></h3>
      <div class="small muted">Captain: ${s.captain_name || s.captain_email}${captainApplied ? null : " (hasn't signed up yet)"}</div>
      <ol>
        ${members.map(
          (e) => html`<li><span>${displayName(e)}${e.user_id === s.captain_user_id ? html` <span class="tag">C</span>` : null}</span>
            ${e.user_id !== s.captain_user_id && (mine || c.admin)
              ? html`<form method="post" action="/t/${t.slug}/draft/release" class="inline">
                  <input type="hidden" name="application_id" value="${e.application_id}">
                  <button class="small ghost" title="Return to pool">Release</button></form>`
              : null}</li>`,
        )}
      </ol>
      ${mine
        ? html`<form method="post" action="/t/${t.slug}/draft/rename" class="actions" style="margin-top:12px">
            <input type="text" name="name" value="${s.name ?? ""}" placeholder="Squad name" maxlength="60" aria-label="Squad name" style="flex:1;min-width:0;border-color:#fff">
            <button class="small">Rename</button></form>`
        : null}
      ${c.admin && !mine
        ? html`<form method="post" action="/t/${t.slug}/draft/remove-squad" class="actions" style="margin-top:12px"
             data-confirm="Remove ${squadName(s)}? Its players go back to the pool.">
            <input type="hidden" name="squad_id" value="${s.id}"><button class="small ghost">Remove squad</button></form>`
        : null}
    </section>`;
  };

  return page(
    `Draft · ${t.name}`,
    { ...c.nav, active: "draft" },
    html`${flash(c)}
    <div class="meta">Draft</div>
    <h1>${t.name}</h1>
    <p class="muted small"><span class="count">${active.length}</span> signed up · <span class="count">${pool.length}</span> in the pool ·
      ${squads.length} ${squads.length === 1 ? "squad" : "squads"} of ${t.squad_size} · <a href="/t/${t.slug}/export.csv">Download CSV</a></p>

    <h2>Squads</h2>
    <div class="squads">${[...squads].sort((a, b) => Number(b.id === mySquad?.id) - Number(a.id === mySquad?.id)).map(squadCard)}</div>

    <h2>Pool</h2>
    ${nominate
      ? null
      : html`<p class="muted small">Another captain can be nominated once more than ${squads.length * t.squad_size} people have signed up.</p>`}
    ${pool.length === 0
      ? html`<p class="muted">Nobody is waiting in the pool.</p>`
      : html`<div class="table-wrap"><table class="pool">
        <thead><tr><th>Name</th><th>NAF</th>${fields.map((f) => html`<th>${f.label}</th>`)}<th>Signed up</th><th></th></tr></thead>
        <tbody>
        ${pool.map((e) => {
          const x: Record<string, string> = JSON.parse(e.extras);
          return html`<tr>
            <td data-label="Name"><strong>${displayName(e)}</strong><div class="small muted">${e.email}</div></td>
            <td data-label="NAF">${e.naf_name}<div class="small muted">#${e.naf_number}</div></td>
            ${fields.map((f) => html`<td class="pre small" data-label="${f.label}">${x[f.key] || html`<span class="muted">—</span>`}</td>`)}
            <td class="small" data-label="Signed up">${formatDate(e.created_at)}</td>
            <td class="row-actions"><div class="actions">
              ${mySquad && myRoom > 0
                ? html`<form method="post" action="/t/${t.slug}/draft/pick" class="inline">
                    <input type="hidden" name="application_id" value="${e.application_id}"><button class="small">Draft</button></form>`
                : null}
              ${nominate && !captainIds.has(e.user_id)
                ? html`<form method="post" action="/t/${t.slug}/draft/nominate" class="inline"
                    data-confirm="Make ${displayName(e)} captain of a new squad?">
                    <input type="hidden" name="application_id" value="${e.application_id}"><button class="small ghost">Make captain</button></form>`
                : null}
            </div></td>
          </tr>`;
        })}
        </tbody></table></div>`}
    ${mySquad && myRoom <= 0 ? html`<p class="muted small">Your squad is full.</p>` : null}`,
  );
}

async function draftAction(c: Ctx, t: Tournament, action: string): Promise<Response> {
  const needLogin = requireLogin(c);
  if (needLogin) return needLogin;
  const form = await c.req.formData();
  const back = (msg: string) => redirect(`/t/${t.slug}/draft?msg=${msg}`);
  const mySquad = await captainSquad(c, t);
  if (!mySquad && !c.admin) return forbidden(c);
  const appId = Number(form.get("application_id"));

  switch (action) {
    case "pick": {
      if (!mySquad) return forbidden(c);
      const ok = await pickIntoSquad(c.env, mySquad.id, appId, c.user!.id);
      return back(ok ? "picked" : "pick-failed");
    }
    case "release": {
      // Captains can release from their own squad; admins from any. Nobody releases a captain.
      await c.env.DB.prepare(
        `DELETE FROM squad_members
          WHERE application_id = ?
            AND squad_id IN (SELECT id FROM squads WHERE tournament_id = ? AND (captain_user_id = ? OR ?))
            AND (SELECT user_id FROM applications WHERE id = ?) <> (SELECT captain_user_id FROM squads WHERE id = squad_id)`,
      )
        .bind(appId, t.id, c.user!.id, c.admin ? 1 : 0, appId)
        .run();
      return back("released");
    }
    case "nominate": {
      const [squads, entries] = await Promise.all([listSquads(c.env, t.id), listEntries(c.env, t.id)]);
      const active = entries.filter((e) => e.status === "active");
      if (!canNominate(active.length, squads.length, t.squad_size)) return back("nominate-not-yet");
      const nominee = active.find((e) => e.application_id === appId);
      if (!nominee || squads.some((s) => s.captain_user_id === nominee.user_id)) return back("nominate-failed");
      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM squad_members WHERE application_id = ?").bind(appId),
        c.env.DB.prepare(
          `INSERT INTO squads (tournament_id, captain_user_id, position)
           SELECT ?, ?, COALESCE(MAX(position), 0) + 1 FROM squads WHERE tournament_id = ?`,
        ).bind(t.id, nominee.user_id, t.id),
        c.env.DB.prepare(
          `INSERT INTO squad_members (application_id, squad_id, added_by)
           SELECT ?, id, ? FROM squads WHERE tournament_id = ? AND captain_user_id = ?`,
        ).bind(appId, c.user!.id, t.id, nominee.user_id),
      ]);
      await sendEmail(c.env, {
        to: nominee.email,
        subject: `You're a captain for ${t.name}`,
        text: `Hi ${displayName(nominee)},

You've been made captain of a new squad for ${t.name}. Sign in and open the Draft tab to pick your squad:

${c.url.origin}/t/${t.slug}/draft`,
      });
      return back("nominated");
    }
    case "rename": {
      if (!mySquad) return forbidden(c);
      const name = String(form.get("name") ?? "").trim().slice(0, 60);
      await c.env.DB.prepare("UPDATE squads SET name = ? WHERE id = ?").bind(name || null, mySquad.id).run();
      return back("renamed");
    }
    case "remove-squad": {
      if (!c.admin) return forbidden(c);
      const squadId = Number(form.get("squad_id"));
      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM squad_members WHERE squad_id = (SELECT id FROM squads WHERE id = ? AND tournament_id = ?)").bind(squadId, t.id),
        c.env.DB.prepare("DELETE FROM squads WHERE id = ? AND tournament_id = ?").bind(squadId, t.id),
      ]);
      return back("squad-removed");
    }
  }
  return notFound(c);
}

async function exportCsv(c: Ctx, t: Tournament): Promise<Response> {
  const needLogin = requireLogin(c);
  if (needLogin) return needLogin;
  if (!c.admin && !(await captainSquad(c, t))) return forbidden(c);
  const [squads, entries] = await Promise.all([listSquads(c.env, t.id), listEntries(c.env, t.id)]);
  const fields = extraFields(t);
  const cell = (v: string | number | null | undefined) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets treating text as a formula
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const squadOf = (e: Entry) => squads.find((s) => s.id === e.squad_id);
  const rows = [
    ["Squad", "Captain", "Name", "Email", "NAF name", "NAF number", ...fields.map((f) => f.label), "Status", "Signed up"],
    ...entries.map((e) => {
      const s = squadOf(e);
      const x: Record<string, string> = JSON.parse(e.extras);
      return [
        s ? squadName(s) : e.status === "active" ? "Pool" : "",
        s && s.captain_user_id === e.user_id ? "yes" : "",
        e.name, e.email, e.naf_name, e.naf_number,
        ...fields.map((f) => x[f.key] ?? ""),
        e.status, e.created_at,
      ];
    }),
  ];
  return new Response(rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${t.slug}.csv"`,
      "cache-control": "no-store",
    },
  });
}

async function devOutbox(c: Ctx): Promise<Response> {
  const { results } = await c.env.DB.prepare("SELECT * FROM dev_outbox ORDER BY id DESC LIMIT 50").all();
  return Response.json(results);
}
