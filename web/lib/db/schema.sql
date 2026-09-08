-- Flight Desk schema.
--
-- Applied on first use and safe to re-run: everything here is IF NOT EXISTS.
-- There is no migration tool; when that stops being enough, add one rather
-- than growing a pile of conditional ALTERs.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  -- Stored lowercased. Unique so two people cannot hold the same login, but
  -- NOT treated as proof of anything: nobody verifies it, so it identifies an
  -- account and never grants access to something filed under that address.
  email       TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  -- The cookie value is hashed before it lands here. A leaked database should
  -- not hand over working sessions the way a leaked password file would.
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- Failed sign-in attempts, so guessing can be slowed without an extra service.
CREATE TABLE IF NOT EXISTS login_attempts (
  email       TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_email_at_idx ON login_attempts(email, at);

/*
 * A person's FluxA agent.
 *
 * `secret` is encrypted before it gets here, with a key held in the
 * environment rather than the database — a dump on its own is useless.
 *
 * Holding it is what lets the agent follow someone to a new browser, and it
 * is the deliberate trade in this design. Note what it does and does not
 * grant: it lets us act AS the agent, not spend. Spending needs a mandate the
 * person signed, so the worst a breach reaches is whatever mandates are
 * currently signed and unspent. Keep mandates one-per-booking and short-lived
 * and that stays bounded to a single fare.
 */
CREATE TABLE IF NOT EXISTS agents (
  agent_id    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret      TEXT NOT NULL,
  -- Null until the person has adopted this agent into their wallet. Until
  -- then it can raise a spending request but cannot read or settle one.
  linked_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_user_idx ON agents(user_id);

-- Saved travellers, scoped to their owner. The previous version was one
-- shared file, which handed every visitor everyone else's passport details.
CREATE TABLE IF NOT EXISTS travellers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  passenger   JSONB NOT NULL,
  contact     JSONB NOT NULL,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS travellers_user_idx ON travellers(user_id);

/*
 * Settlements, keyed by order.
 *
 * The primary key IS the idempotency guard: a charge cannot be taken back, and
 * a retried request is indistinguishable from a genuine one. This lived in a
 * file on container disk, which does not survive a redeploy and is not shared
 * between instances — so the guard was absent in exactly the conditions that
 * need it.
 */
CREATE TABLE IF NOT EXISTS settlements (
  order_id    TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  amount_usd  NUMERIC(12, 2) NOT NULL,
  tx_hash     TEXT,
  rail        TEXT NOT NULL,
  mandate_id  TEXT NOT NULL,
  settled_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlements_user_idx ON settlements(user_id);
