import { CloudHttpError, cloudRequest, type CloudFetch } from "./client.js";
import { getCredential, removeCredential, saveCredential } from "./credentials.js";

export interface AccountIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  fetch: CloudFetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

interface Me {
  email: string;
  organizations: Array<{ slug: string; name: string; role: string; plan: { active: boolean; reason: string; until: string | null } }>;
}

function parseMe(json: Record<string, unknown>): Me {
  const user = (json.user ?? {}) as { email?: unknown };
  const orgs = Array.isArray(json.organizations) ? (json.organizations as Me["organizations"]) : [];
  return { email: typeof user.email === "string" ? user.email : "?", organizations: orgs };
}

export const PLAN_TEXT: Record<string, string> = {
  active: "Team (active)",
  trialing: "Team (trial)",
  grace_period: "Team (payment failed, grace period)",
  paid_until_period_end: "Team (cancelled, paid until period end)",
};

function describeOrgs(me: Me): string[] {
  if (me.organizations.length === 0) return ["  (no organizations yet: create or join one in the browser)"];
  return me.organizations.map((o) => `  ${o.slug}  ${o.role.padEnd(8)} ${o.plan.active ? (PLAN_TEXT[o.plan.reason] ?? "Team") : "Free (sync is off)"}`);
}

/**
 * `ard login`: the device flow. We show a short code and a link; the person confirms in a browser where they are
 * already signed in (with SSO, 2FA, whatever the site requires). The CLI never sees a password.
 */
export async function runLogin(io: AccountIo, server: string): Promise<number> {
  const started = await cloudRequest(io.fetch, server, "/api/v1/device/code", { method: "POST", body: {} });
  const deviceCode = String(started.device_code ?? "");
  const userCode = String(started.user_code ?? "");
  const link = String(started.verification_uri_complete ?? started.verification_uri ?? "");
  if (!deviceCode || !userCode || !link) throw new CloudHttpError(null, "The server did not start a login. Is this really an Agent Review Desk Cloud?");
  const deadline = io.now().getTime() + Number(started.expires_in ?? 600) * 1000;
  let interval = Math.max(1, Number(started.interval ?? 5)) * 1000;

  io.out(`To sign in, open this link in your browser:\n\n  ${link}\n\nand confirm the code  ${userCode}\n\nOnly approve it if you see this exact code in YOUR terminal. Waiting...`);

  while (io.now().getTime() < deadline) {
    await io.sleep(interval);
    try {
      const done = await cloudRequest(io.fetch, server, "/api/v1/device/token", { method: "POST", body: { device_code: deviceCode } });
      const token = String(done.access_token ?? "");
      if (!token) throw new CloudHttpError(null, "The server approved the login but sent no token.");
      saveCredential(io.env, server, { token, email: String(done.email ?? ""), savedAt: io.now().toISOString() });
      const me = parseMe(await cloudRequest(io.fetch, server, "/api/v1/me", { token }));
      io.out(`\nSigned in as ${me.email} on ${server}.\nOrganizations:\n${describeOrgs(me).join("\n")}\nNext: ard sync --org <slug>`);
      return 0;
    } catch (error) {
      if (!(error instanceof CloudHttpError)) throw error;
      if (error.status === 400 && error.code === "authorization_pending") continue;
      if (error.status === 400 && error.code === "slow_down") {
        interval += 5000;
        continue;
      }
      if (error.status === 400 && error.code === "access_denied") {
        io.err("The login was refused in the browser. Nothing was saved.");
        return 1;
      }
      if (error.status === 400 && (error.code === "expired_token" || error.code === "invalid_grant")) {
        io.err("The code expired. Run `ard login` again.");
        return 1;
      }
      throw error;
    }
  }
  io.err("Timed out waiting for approval. Run `ard login` again.");
  return 1;
}

/** `ard logout`: revoke the token on the server (best effort) and delete it here. */
export async function runLogout(io: AccountIo, server: string): Promise<number> {
  const credential = getCredential(io.env, server);
  if (!credential) {
    io.out(`Not signed in to ${server}.`);
    return 0;
  }
  let revoked = true;
  try {
    await cloudRequest(io.fetch, server, "/api/v1/logout", { method: "POST", token: credential.token, body: {} });
  } catch {
    revoked = false; // offline, or already revoked: still remove it locally
  }
  removeCredential(io.env, server);
  io.out(revoked ? `Signed out of ${server}. The token no longer works.` : `Signed out locally. The server could not be reached to revoke the token, so revoke it in the browser if this machine is shared.`);
  return 0;
}

/** `ard whoami` */
export async function runWhoami(io: AccountIo, server: string): Promise<number> {
  const credential = getCredential(io.env, server);
  if (!credential) {
    io.err(`Not signed in to ${server}. Run: ard login`);
    return 1;
  }
  const me = parseMe(await cloudRequest(io.fetch, server, "/api/v1/me", { token: credential.token }));
  io.out(`${me.email} on ${server}\nOrganizations:\n${describeOrgs(me).join("\n")}`);
  return 0;
}

/** The token for a server, or an error that says what to do. */
export function requireToken(env: NodeJS.ProcessEnv, server: string): string {
  const credential = getCredential(env, server);
  if (!credential) throw new CloudHttpError(401, `Not signed in to ${server}. Run: ard login`);
  return credential.token;
}
