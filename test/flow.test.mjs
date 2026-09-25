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

async function signUp(email, name, allergens = "None") {
  const res = await post(`/t/${SLUG}/apply`, {
    email, name, naf_name: name.replace(/\s/g, ""), naf_number: String(10000 + Object.keys(people).length),
    x_extras: "", x_allergens: allergens,
  });
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
  assert.match(html, /Please fill in allergens/);
});

test("full sign-up and draft flow", async () => {
  // The first admin signs up and becomes captain of squad 1 automatically.
  const karl = await signUp(ADMIN, "Karl");
  let draft = await (await get(`/t/${SLUG}/draft`, karl)).text();
  assert.match(draft, /Squad 1/);
  assert.match(draft, /1\/6/);

  // Links are single use.
  const reused = await post("/auth", { token: await latestLinkFor(ADMIN) });
  assert.match(reused.headers.get("location"), /link-invalid/);

  // Five more people: six signed up, so no second captain yet.
  for (let i = 1; i <= 5; i++) await signUp(`p${i}@example.com`, `Player ${i}`, i === 1 ? "Peanuts" : "None");
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
  assert.match(p6Html, /Squad 2/);
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
  assert.match(csv, /^Squad,Captain,Name,Email,NAF name,NAF number,Optional extras purchase requests,Allergens,Status,Signed up/);
  assert.match(csv, /Peanuts/);
  assert.match(csv, /Squad 2,yes,Player 6/);
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
