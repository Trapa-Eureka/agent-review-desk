/**
 * Control-plane database: accounts, organizations, roles, credentials, billing state.
 * (The recorded sessions themselves live in one separate SQLite file per organization.)
 *
 * Append-only, like core's MIGRATIONS: never edit an entry that has shipped.
 */
export const CLOUD_MIGRATIONS: readonly string[] = [
  `
  -- A user is a person. Platform users sign in with the operator's login provider (home_org_id NULL).
  -- SSO users are created by ONE organization's identity provider and are scoped to it (home_org_id set):
  -- they are never merged with a platform user who happens to share the e-mail address, because the
  -- organization that configured the IdP must not be able to take over someone else's account.
  CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    name        TEXT,
    home_org_id TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX users_email_scope ON users (email, COALESCE(home_org_id, ''));

  CREATE TABLE identities (
    provider TEXT NOT NULL,
    subject  TEXT NOT NULL,
    user_id  TEXT NOT NULL REFERENCES users (id),
    PRIMARY KEY (provider, subject)
  );

  CREATE TABLE orgs (
    id                       TEXT PRIMARY KEY,
    slug                     TEXT NOT NULL UNIQUE,
    name                     TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    billing_provider         TEXT,
    billing_customer_id      TEXT,
    billing_subscription_id  TEXT,
    sub_status               TEXT,
    sub_period_end           TEXT,
    sub_cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    sub_past_due_since       TEXT,
    sub_plan_ref             TEXT,
    sub_event_at             TEXT,
    sso_enforced             INTEGER NOT NULL DEFAULT 0,
    stored_bytes             INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE memberships (
    org_id     TEXT NOT NULL REFERENCES orgs (id),
    user_id    TEXT NOT NULL REFERENCES users (id),
    role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'reviewer', 'member')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id)
  );

  CREATE TABLE invitations (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES orgs (id),
    email       TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('admin', 'reviewer', 'member')),
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    accepted_at TEXT
  );

  CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id),
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT,
    expires_at   TEXT
  );

  -- Device authorization (RFC 8628 style) for \`ard login\`.
  CREATE TABLE device_codes (
    device_hash  TEXT PRIMARY KEY,
    user_code    TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
    user_id      TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_poll_at TEXT,
    interval_s   INTEGER NOT NULL
  );

  CREATE TABLE web_sessions (
    id_hash    TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    sso_org_id TEXT
  );

  CREATE TABLE sso_configs (
    org_id               TEXT PRIMARY KEY REFERENCES orgs (id),
    issuer               TEXT NOT NULL,
    client_id            TEXT NOT NULL,
    client_secret_sealed TEXT NOT NULL,
    email_domain         TEXT NOT NULL,
    default_role         TEXT NOT NULL CHECK (default_role IN ('admin', 'reviewer', 'member')),
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
  );

  -- An OIDC login in flight: single use, short lived.
  CREATE TABLE login_states (
    state_hash    TEXT PRIMARY KEY,
    nonce         TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    org_id        TEXT,
    return_to     TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  );

  -- Every checkout WE start. A webhook is tied to an organization only through this table.
  CREATE TABLE checkouts (
    id         TEXT PRIMARY KEY,
    nonce_hash TEXT NOT NULL UNIQUE,
    org_id     TEXT NOT NULL REFERENCES orgs (id),
    user_id    TEXT NOT NULL,
    provider   TEXT NOT NULL,
    reference  TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX checkouts_reference ON checkouts (provider, reference);

  -- Webhook ids already handled (providers deliver at least once).
  CREATE TABLE billing_events (
    provider    TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (provider, event_id)
  );

  -- Which member first uploaded a session. Only that member may add to it.
  CREATE TABLE uploads (
    org_id     TEXT NOT NULL,
    session_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    first_at   TEXT NOT NULL,
    PRIMARY KEY (org_id, session_id)
  );

  CREATE TABLE audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id        TEXT,
    actor_user_id TEXT,
    action        TEXT NOT NULL,
    detail        TEXT,
    at            TEXT NOT NULL
  );
  CREATE INDEX audit_org ON audit_log (org_id, id);
  `,
];
