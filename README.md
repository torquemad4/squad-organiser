# Tactics and Theatrics: Squad Organiser

A sign-up portal where Tactics and Theatrics members sign up for team tournaments, and captains draft squads from the pool.

It runs as a Cloudflare Worker with a D1 database. Sign-in works by email link (no passwords), and emails are sent through [Resend](https://resend.com).

## How it works

- **Sign up.** Pick a tournament and fill in your name, email, NAF name and NAF number (always required), plus any questions that tournament adds. If you're not signed in, you get an email link; your sign-up is saved when you click it. You can come back to change your answers or withdraw.
- **Pool.** Every active sign-up goes into the tournament's pool.
- **Captains.** The first address in `ADMIN_EMAILS` is the first captain of every tournament. When more people have signed up than the existing squads can hold (more than 6 for one squad, more than 12 for two, and so on), a captain or admin can make someone from the pool captain of a new squad. The new captain gets an email.
- **Draft tab.** Captains see a Draft tab. From there they can draft people from the pool into their own squad, release them back to the pool, rename their squad, and download everything as CSV. Picks are first come, first served: a player can only be in one squad, and a captain's own seat is always kept free for them.
- **Admins** can also release players from any squad, remove squads, and close or reopen sign-ups.

## Tournaments

Tournaments are added with a migration; see `migrations/0002_world_cup_2027.sql`. `extra_fields` is a JSON list of extra questions. Each question has a `key`, a `label`, a `type` (`text`, `textarea`, `checkbox` or `select`, where `select` takes `options`), and optional `required` and `help`.

The World Cup 2027 entry asks for optional extras purchase requests and for allergens. Allergens is required; people write "None" if they have none.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # EMAIL_MODE=dev, and put your email in ADMIN_EMAILS
npm run dev
```

With `EMAIL_MODE=dev`, emails aren't sent. They're printed in the terminal, and you can read them at `/__dev/outbox`.

```sh
npm run typecheck
npm test        # starts wrangler dev against a throwaway database and runs the whole flow
```

## Deploying

1. `npx wrangler login`
2. `npx wrangler d1 create squad-organiser`, then copy the `database_id` it prints into `wrangler.jsonc`.
3. Set up a Resend account, verify the sending domain, and set `EMAIL_FROM` in `wrangler.jsonc` to an address on that domain.
4. `npx wrangler secret put RESEND_API_KEY`
5. `npx wrangler secret put ADMIN_EMAILS`: comma-separated, with the first captain listed first.
6. `npm run deploy`: this applies the migrations and deploys.
7. Optional: add a custom domain to the Worker in the Cloudflare dashboard.
