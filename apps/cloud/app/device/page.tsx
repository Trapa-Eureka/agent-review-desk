import Flash, { param } from "../../components/Flash";
import { requirePrincipal } from "../../lib/auth";

export const dynamic = "force-dynamic";

export default async function DevicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const code = (param(params.code) ?? "").slice(0, 20);
  const principal = await requirePrincipal(code ? `/device?code=${encodeURIComponent(code)}` : "/device");

  return (
    <>
      <h1>Sign in the command line</h1>
      <Flash params={params} />
      <p>
        You are signed in as <strong>{principal.user.email}</strong>. If you approve, the <code>ard</code> program that is showing a code in your terminal will act as you.
      </p>
      <section className="card">
        <form method="post" action="/api/device/approve" className="stack">
          <label>
            The code shown in your terminal
            <input type="text" name="code" defaultValue={code} placeholder="ABCD-EFGH" required autoComplete="off" maxLength={20} />
          </label>
          <div className="inline-form">
            <button type="submit" name="decision" value="approve" className="btn primary">
              Approve
            </button>
            <button type="submit" name="decision" value="deny" className="btn danger">
              Refuse
            </button>
          </div>
        </form>
      </section>
      <p className="flash warn">Only approve a code you just saw in YOUR OWN terminal. If someone sent you this link or a code, do not approve it: it would give them access to your account.</p>
    </>
  );
}
