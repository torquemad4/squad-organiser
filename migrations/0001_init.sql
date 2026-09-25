-- People. Name, email, NAF name and NAF number are always required when applying,
-- so they live on the user and are refreshed by every application.
CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT,
  naf_name    TEXT,
  naf_number  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- extra_fields is a JSON array of per-tournament questions:
--   [{ "key": "allergens", "label": "Allergens", "type": "textarea"|"text"|"checkbox"|"select",
--      "required": true, "help": "...", "options": ["..."] }]
CREATE TABLE tournaments (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  location      TEXT,
  dates         TEXT,
  description   TEXT,
  squad_size    INTEGER NOT NULL CHECK (squad_size > 0),
  extra_fields  TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One application per person per tournament. Active applications form the pool.
CREATE TABLE applications (
  id             INTEGER PRIMARY KEY,
  tournament_id  INTEGER NOT NULL REFERENCES tournaments(id),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  extras         TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tournament_id, user_id)
);

-- Each squad has exactly one captain.
CREATE TABLE squads (
  id               INTEGER PRIMARY KEY,
  tournament_id    INTEGER NOT NULL REFERENCES tournaments(id),
  captain_user_id  INTEGER NOT NULL REFERENCES users(id),
  name             TEXT,
  position         INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tournament_id, captain_user_id),
  UNIQUE (tournament_id, position)
);

-- An application can sit in at most one squad; the primary key enforces that.
CREATE TABLE squad_members (
  application_id  INTEGER PRIMARY KEY REFERENCES applications(id),
  squad_id        INTEGER NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  added_by        INTEGER REFERENCES users(id),
  added_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX squad_members_squad ON squad_members (squad_id);

-- Email sign-in links. Only a SHA-256 hash of each token is stored.
-- payload carries a pending application, or where to go after signing in.
CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL COLLATE NOCASE,
  payload     TEXT NOT NULL DEFAULT '{}',
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX login_tokens_email ON login_tokens (email, created_at);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Only written when EMAIL_MODE=dev.
CREATE TABLE dev_outbox (
  id          INTEGER PRIMARY KEY,
  to_addr     TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
