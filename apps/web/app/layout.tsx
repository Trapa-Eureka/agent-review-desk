import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import StripToken from "../components/StripToken";
import { tidyPath } from "../lib/present";
import "./globals.css";

export const metadata = {
  title: "Agent Review Desk",
  description: "Review and approval workspace for AI agent runs",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const project = process.env.ARD_PROJECT_DIR;
  return (
    <html lang="en">
      <body>
        <Suspense fallback={null}>
          <StripToken />
        </Suspense>
        <header className="top">
          <Link href="/" className="brand">
            Agent Review Desk
          </Link>
          {project ? <span className="muted project">{tidyPath(project)}</span> : null}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
