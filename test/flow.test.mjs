// End-to-end test: runs the real Worker under `wrangler dev` with a throwaway local D1,
// then drives sign-ups, email links and the draft over HTTP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "captain@example.com";
const SLUG = "world-cup-2027";
let dir, server;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "squad-test-"));
  const wrangler = ["node_modules/.bin/wrangler"];
  execFileSync(wrangler[0], ["d1", "migrations", "apply", "squad-organiser", "--local", "--persist-to", dir], { stdio: "ignore" });
  server = spawn(
    wrangler[0],
    ["dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", dir,
     "--var", "EMAIL_MODE:dev", "--var", `ADMIN_EMAILS:${ADMIN}`],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE + "/")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
});

after(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path, fields, cookie, headers = {}) {
  return fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}), ...headers },
    body: new URLSearchParams(fields),
  });
}

async function get(path, cookie) {
  return fetch(BASE + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

async function latestLinkFor(email) {
  const outbox = await (await get("/__dev/outbox")).json();
  const mail = outbox.find((m) => m.to_addr === email);
  assert.ok(mail, `no email for ${email}`);
  return mail.body.match(/\/auth\?token=([\w-]+)/)[1];
}

async function useLink(token) {
  const confirmPage = await get(`/auth?token=${token}`);
  assert.equal(confirmPage.status, 200, "GET on the link must not consume it");
  const res = await post("/auth", { token });
  assert.equal(res.status, 303);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  return { res, cookie };
}

const people = {};

async function signUp(email, name, allergens = "None", extras = []) {
  const res = await post(`/t/${SLUG}/apply`, [
    ["email", email], ["name", name], ["naf_name", name.replace(/\s/g, "")],
    ["naf_number", String(10000 + Object.keys(people).length)], ["x_allergens", allergens],
    ...extras.map((k) => ["x_extras", k]),
  ]);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Check your email/);
  const { res: done, cookie } = await useLink(await latestLinkFor(email));
  assert.match(done.headers.get("location"), new RegExp(`/t/${SLUG}\\?msg=applied`));
  people[email] = cookie;
  return cookie;
}

function appIdsInPool(html) {
  return [...html.matchAll(/action="\/t\/world-cup-2027\/draft\/pick"[^]*?name="application_id" value="(\d+)"/g)].map((m) => m[1]);
}

test("home lists the World Cup", async () => {
  const html = await (await get("/")).text();
  assert.match(html, /Blood Bowl World Cup 2027/);
  assert.match(html, /Squads of 6/);
  assert.match(html, /logo\.png/);
});

test("validation: required fields and allergens", async () => {
  const res = await post(`/t/${SLUG}/apply`, { email: "bad", name: "", naf_name: "", naf_number: "abc", x_allergens: "" });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /Enter a valid email address/);
  assert.match(html, /Enter your NAF number/);
  assert.match(html, /Please fill in dietary restrictions/);
});

test("full sign-up and draft flow", async () => {
  // The first admin signs up and becomes captain of squad 1 automatically.
  const karl = await signUp(ADMIN, "Karl");
  let draft = await (await get(`/t/${SLUG}/draft`, karl)).text();
  assert.match(draft, /<span>Tactics &amp; Theatrics X<\/span>/);
  assert.match(draft, /1\/6/);

  // Links are single use.
  const reused = await post("/auth", { token: await latestLinkFor(ADMIN) });
  assert.match(reused.headers.get("location"), /link-invalid/);

  // Five more people: six signed up, so no second captain yet.
  for (let i = 1; i <= 5; i++) await signUp(`p${i}@example.com`, `Player ${i}`, i === 1 ? "Peanuts" : "None", i === 1 ? ["coin", "pitch"] : []);
  draft = await (await get(`/t/${SLUG}/draft`, karl)).text();
  assert.doesNotMatch(draft, /Make captain/);
  assert.match(draft, /more than 6 people/);
  const firstPool = appIdsInPool(draft);
  const early = await post(`/t/${SLUG}/draft/nominate`, { application_id: firstPool[0] }, karl);
  assert.match(early.headers.get("location"), /nominate-not-yet/);

  // A seventh makes nomination possible.
  await signUp("p6@example.com", "Player 6");
  draft = await (await get(`/t/${SLUG}/draft`, karl)).text();
  assert.match(draft, /Make captain/);

  // Non-captains can't see the draft.
  assert.equal((await get(`/t/${SLUG}/draft`, people["p1@example.com"])).status, 403);

  // Karl drafts five: his squad is then full.
  const pool = appIdsInPool(draft);
  assert.equal(pool.length, 6);
  for (const id of pool.slice(0, 5)) {
    const r = await post(`/t/${SLUG}/draft/pick`, { application_id: id }, karl);
    assert.match(r.headers.get("location"), /msg=picked/);
  }
  const over = await post(`/t/${SLUG}/draft/pick`, { application_id: pool[5] }, karl);
  assert.match(over.headers.get("location"), /pick-failed/);

  // Karl nominates Player 6 as the second captain.
  const nom = await post(`/t/${SLUG}/draft/nominate`, { application_id: pool[5] }, karl);
  assert.match(nom.headers.get("location"), /msg=nominated/);
  const p6 = people["p6@example.com"];
  const p6Draft = await get(`/t/${SLUG}/draft`, p6);
  assert.equal(p6Draft.status, 200);
  const p6Html = await p6Draft.text();
  assert.match(p6Html, /<span>Tactics &amp; Theatrics O<\/span>/);
  // The World Cup has at most two squads: no more nominations.
  assert.doesNotMatch(p6Html, /Make captain/);
  const third = await post(`/t/${SLUG}/draft/nominate`, { application_id: pool[4] }, karl);
  assert.match(third.headers.get("location"), /nominate-max/);
  assert.match(p6Html, /href="\/draft"/, "captains get the Draft tab");

  // A drafted player can't be stolen by another captain.
  const steal = await post(`/t/${SLUG}/draft/pick`, { application_id: pool[0] }, p6);
  assert.match(steal.headers.get("location"), /pick-failed/);

  // Karl releases one; it goes back to the pool and p6 can draft them.
  await post(`/t/${SLUG}/draft/release`, { application_id: pool[0] }, karl);
  const took = await post(`/t/${SLUG}/draft/pick`, { application_id: pool[0] }, p6);
  assert.match(took.headers.get("location"), /msg=picked/);

  // Player sees their squad on My sign-ups.
  const me = await (await get("/me", people["p1@example.com"])).text();
  assert.match(me, /Drafted|In the pool/);

  // Withdrawal takes a drafted player out of their squad.
  const drafted = await (await get("/me", people["p2@example.com"])).text();
  assert.match(drafted, /Drafted/);
  await post(`/t/${SLUG}/withdraw`, {}, people["p2@example.com"]);
  assert.match(await (await get("/me", people["p2@example.com"])).text(), /Withdrawn/);

  // Captains can't withdraw.
  const cw = await post(`/t/${SLUG}/withdraw`, {}, p6);
  assert.match(cw.headers.get("location"), /captain-cannot-withdraw/);

  // CSV export includes squads and extras.
  const csv = await (await get(`/t/${SLUG}/export.csv`, karl)).text();
  assert.match(csv, /^Squad,Captain,Name,Email,NAF name,NAF number,Extras,Dietary restrictions,Ticket,Extras total,Total,Paid,Status,Signed up/);
  assert.match(csv, /Tournament Coin, World Cup 2027 Neoprene Pitch",Peanuts,195\.00,55\.00,250\.00,/);
  assert.match(csv, /Peanuts/);
  assert.match(csv, /\nTactics & Theatrics O,yes,Player 6/);
  assert.equal((await get(`/t/${SLUG}/export.csv`, people["p3@example.com"])).status, 403);
});

test("signed-in users can update their sign-up", async () => {
  const cookie = people["p3@example.com"];
  const res = await post(`/t/${SLUG}/apply`, { name: "Player Three", naf_name: "P3", naf_number: "123", x_allergens: "Gluten" }, cookie);
  assert.match(res.headers.get("location"), /msg=updated/);
  const html = await (await get(`/t/${SLUG}`, cookie)).text();
  assert.match(html, /Gluten/);
  assert.match(html, /Player Three/);
});

test("cross-site posts are refused", async () => {
  const res = await post("/logout", {}, people["p3@example.com"], { origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

test("login rate limit", async () => {
  for (let i = 0; i < 5; i++) await post("/login", { email: "spam@example.com" });
  const res = await post("/login", { email: "spam@example.com" });
  assert.match(await res.text(), /Too many links/);
});

test("extras tick-list: ticket + extras totals, admin page and paid tick box", async () => {
  const p1 = people["p1@example.com"];
  const euros = (html, label) => Number(html.match(new RegExp(label + `</div><div class="stat">€([\\d,]+)<`))[1].replace(/,/g, ""));
  // Player 1 ticked coin (€15) + pitch (€40); with the €195 ticket that's €250.
  const own = await (await get(`/t/${SLUG}`, p1)).text();
  assert.match(own, /Your total is <strong>€250<\/strong>/);
  assert.match(own, /data-base="19500"/);
  assert.match(own, /<span>Ticket<span class="small muted"><br>Event entry, lunch/);
  assert.match(own, /href="https:\/\/nafwc\.com\/tickets\/" target="_blank"/);
  assert.match(own, /value="coin" data-price="1500"\s+checked/);
  assert.match(own, /Pack of Legends<\/span><span class="price">€175/);
  assert.match(own, /<label for="f_x_allergens">Dietary restrictions/);
  assert.match(await (await get("/me", p1)).text(), /Your total: <strong>€250<\/strong>[^]*not paid yet/);

  // Unknown item keys are ignored.
  await post(`/t/${SLUG}/apply`, [["name", "Player 1"], ["naf_name", "P1"], ["naf_number", "1"], ["x_allergens", "Peanuts"],
    ["x_extras", "coin"], ["x_extras", "pitch"], ["x_extras", "free_beer"]], p1);
  assert.match(await (await get(`/t/${SLUG}`, p1)).text(), /Your total is <strong>€250</);

  // Only admins see the admin page.
  assert.equal((await get(`/t/${SLUG}/admin`, p1)).status, 403);
  const karl = people[ADMIN];
  let admin = await (await get(`/t/${SLUG}/admin`, karl)).text();
  const signedUp = Number(admin.match(/Sign-ups \((\d+)\)/)[1]);
  const owed = signedUp * 195 + 55;
  assert.match(admin, /href="\/admin"/, "admins get the Admin tab");
  assert.equal(euros(admin, "Owed in total"), owed);
  assert.equal(euros(admin, "Outstanding"), owed);
  assert.match(admin, new RegExp(`<td><strong>Tickets</strong></td><td class="num">${signedUp}</td>`));
  assert.match(admin, /<td>Tournament Coin<\/td><td class="num">1<\/td>/);

  // Mark Player 1 paid.
  const appId = admin.match(/name="application_id" value="(\d+)">\s*<input type="hidden" name="paid" value="0">\s*<label class="check"><input type="checkbox" name="paid" value="1" data-autosubmit\s*aria-label="Paid: Player 1"/)[1];
  const r = await post(`/t/${SLUG}/admin/paid`, [["application_id", appId], ["paid", "0"], ["paid", "1"]], karl);
  assert.match(r.headers.get("location"), /paid-updated/);
  admin = await (await get(`/t/${SLUG}/admin`, karl)).text();
  assert.equal(euros(admin, "Paid"), 250);
  assert.equal(euros(admin, "Outstanding"), owed - 250);
  assert.match(await (await get("/me", p1)).text(), /<span class="tag">Paid<\/span>/);

  // Player 1 adds Pack of Legends after paying: admin sees the difference.
  await post(`/t/${SLUG}/apply`, [["name", "Player 1"], ["naf_name", "P1"], ["naf_number", "1"], ["x_allergens", "Peanuts"],
    ["x_extras", "coin"], ["x_extras", "pitch"], ["x_extras", "pack_of_legends"]], p1);
  admin = await (await get(`/t/${SLUG}/admin`, karl)).text();
  assert.match(admin, /Paid €250; total is now €425/);
  assert.equal(euros(admin, "Outstanding"), owed + 175 - 250);

  // Unticking clears it.
  await post(`/t/${SLUG}/admin/paid`, [["application_id", appId], ["paid", "0"]], karl);
  admin = await (await get(`/t/${SLUG}/admin`, karl)).text();
  assert.equal(euros(admin, "Outstanding"), owed + 175);
  const csv = await (await get(`/t/${SLUG}/export.csv`, karl)).text();
  assert.match(csv, /Pack of Legends",Peanuts,195\.00,230\.00,425\.00,,active/);
});

test("members see who's signed up and their squad, without private details", async () => {
  const anon = await (await get(`/t/${SLUG}`)).text();
  assert.match(anon, /Sign in<\/a> to see who's signed up/);
  assert.doesNotMatch(anon, /Player 3/);

  const html = await (await get(`/t/${SLUG}`, people["p4@example.com"])).text();
  assert.match(html, /Who's signed up \(\d+\)/);
  assert.match(html, /<span class="squad-mark">Tactics &amp; Theatrics X<\/span>/);
  assert.match(html, /<span class="squad-mark">Tactics &amp; Theatrics O<\/span>/);
  assert.match(html, /Player 6 <span class="tag">C<\/span>/);
  assert.match(html, /Player Three/);
  assert.doesNotMatch(html, /p3@example\.com|Gluten|Peanuts/);
});
