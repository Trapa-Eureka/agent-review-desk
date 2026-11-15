import { orgEntitlement } from "@ard/cloud";
import { dateTime } from "@ard/ui/present";
import Flash, { param } from "../../../../components/Flash";
import OrgNav from "../../../../components/OrgNav";
import { orgContext } from "../../../../lib/auth";
import { getCloud } from "../../../../lib/cloud";

export const dynamic = "force-dynamic";

const REASONS: Record<string, string> = {
  active: "Active",
  trialing: "In trial",
  grace_period: "Payment failed: access continues for a grace period",
  paid_until_period_end: "Cancelled: access continues until the paid period ends",
  payment_failed: "Payment failed: access has stopped",
  paused: "Paused",
  ended: "Ended",
  never_paid: "Checkout started but not completed",
  no_subscription: "Free plan",
};

export default async function Billing({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const query = await searchParams;
  const ctx = await orgContext(slug, "billing.manage", `/o/${slug}/billing`);
  if (!ctx.ok) return <p className="flash error">{ctx.message}</p>;
  const cloud = getCloud();
  const { org, role } = ctx.access;
  const plan = orgEntitlement(org, cloud.control.time());
  const providers = [...cloud.providers.values()];
  const subscribed = org.subStatus !== null && org.billingProvider !== null;
  const returning = param(query.checkout) === "return";

  return (
    <>
      <h1>{org.name}</h1>
      <OrgNav slug={slug} role={role} current="billing" />
      <Flash params={query} />
      {returning ? <p className="flash notice">Thanks! Payment confirmations arrive from the payment provider within a minute or so. Reload this page if the plan below has not changed yet.</p> : null}

      <section className="card">
        <h2>Plan</h2>
        <div className="plan">
          {plan.active ? <span className="badge ok">Team</span> : <span className="badge neutral">Free</span>}
          <span>{REASONS[plan.reason] ?? plan.reason}</span>
        </div>
        {plan.until ? <p className="hint">Access until {dateTime(plan.until)}.</p> : null}
        {subscribed ? (
          <p className="hint">
            Billed through {org.billingProvider === "paddle" ? "Paddle" : "Dodo Payments"}
            {org.subPeriodEnd ? <>; next renewal or end of period: {dateTime(org.subPeriodEnd)}</> : null}.
          </p>
        ) : null}
        <p className="hint">Free: record and review on your own machine, always. Team: sync sessions to this workspace, share them, review together, roles and single sign-on.</p>
      </section>

      {org.billingCustomerId ? (
        <section className="card">
          <h2>Manage subscription</h2>
          <p>Update the card, download invoices or cancel on the provider&apos;s secure page.</p>
          <form method="post" action={`/api/o/${slug}/billing/portal`}>
            <button type="submit" className="btn plain">
              Open billing portal
            </button>
          </form>
        </section>
      ) : null}

      {!plan.active || org.subCancelAtPeriodEnd ? (
        <section className="card">
          <h2>{subscribed ? "Subscribe again" : "Subscribe to Team"}</h2>
          {providers.length === 0 ? (
            <p className="flash warn">No payment provider is configured on this server yet.</p>
          ) : (
            <>
              <p>Monthly subscription, cancel any time. You pay on the provider&apos;s page; we never see your card.</p>
              <div className="inline-form">
                {providers.map((p) => (
                  <form key={p.id} method="post" action={`/api/o/${slug}/billing/checkout`}>
                    <input type="hidden" name="provider" value={p.id} />
                    <button type="submit" className="btn primary">
                      Pay with {p.label}
                    </button>
                  </form>
                ))}
              </div>
            </>
          )}
        </section>
      ) : null}
    </>
  );
}
