import type { ReactNode } from "react";
import Link from "next/link";
import { CloudConfigError } from "@ard/cloud";
import "@ard/ui/styles.css";
import "./cloud.css";
import { currentPrincipal } from "../lib/auth";
import { getCloud } from "../lib/cloud";

export const metadata = {
  title: "Agent Review Desk Cloud",
  description: "Team workspace for reviewing AI agent runs",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  let problems: string[] | null = null;
  try {
    getCloud();
  } catch (error) {
    if (!(error instanceof CloudConfigError)) throw error;
    problems = error.problems;
  }
  const principal = problems ? null : await currentPrincipal();

  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">
            Agent Review Desk <span className="muted">Cloud</span>
          </Link>
          {principal ? (
            <nav aria-label="Account">
              <span className="muted">{principal.user.email}</span>
              <form method="post" action="/api/auth/logout">
                <button type="submit" className="linklike">
                  Sign out
                </button>
              </form>
            </nav>
          ) : null}
        </header>
        <main>
          {problems ? (
            <section>
              <h1>This server is not configured yet</h1>
              <p>Fix these in the server&apos;s environment and restart it:</p>
              <ul className="config-problems">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </section>
          ) : (
            children
          )}
        </main>
      </body>
    </html>
  );
}
