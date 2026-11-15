import Link from "next/link";
import { can, type Role } from "@ard/cloud";

type Tab = "sessions" | "members" | "billing" | "sso";

/** The tabs an organization page offers. Tabs a role can never use are not shown. */
export default function OrgNav({ slug, role, current }: { slug: string; role: Role; current: Tab }) {
  const tabs: Array<{ id: Tab; label: string; href: string; show: boolean }> = [
    { id: "sessions", label: "Sessions", href: `/o/${slug}`, show: true },
    { id: "members", label: "Members", href: `/o/${slug}/members`, show: true },
    { id: "billing", label: "Billing", href: `/o/${slug}/billing`, show: can(role, "billing.manage") },
    { id: "sso", label: "Single sign-on", href: `/o/${slug}/sso`, show: can(role, "sso.manage") },
  ];
  return (
    <nav className="tabs" aria-label="Organization">
      {tabs
        .filter((t) => t.show)
        .map((t) => (
          <Link key={t.id} href={t.href} aria-current={t.id === current ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
    </nav>
  );
}
