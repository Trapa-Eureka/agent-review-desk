import type { ReactNode } from "react";

export const metadata = {
  title: "Agent Review Desk",
  description: "Review and approval workspace for AI agent runs",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
