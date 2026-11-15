import type { SubscriptionStatus } from "./types.js";

/** How long a subscription whose payment failed keeps access, counted from when we first saw it fail. */
export const DEFAULT_GRACE_DAYS = 7;

export type EntitlementReason = "active" | "trialing" | "grace_period" | "paid_until_period_end" | "payment_failed" | "paused" | "ended" | "never_paid" | "no_subscription";

export interface Entitlement {
  /** May this organization use paid features (cloud sync, team workspace)? */
  active: boolean;
  reason: EntitlementReason;
  /** When access is scheduled to stop, if known. */
  until: string | null;
}

export interface EntitlementInput {
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** When `past_due` was first observed (ISO-8601). */
  pastDueSince?: string | null;
}

/**
 * The single place that turns a subscription state into "may they use it?".
 *
 *  - active / trialing: yes.
 *  - past_due: yes for a grace period (a card that failed once should not lock a team out the same hour), then no.
 *  - canceled / expired: only while a period that was already paid for has not run out.
 *  - paused / incomplete: no.
 */
export function entitlementFor(input: EntitlementInput | null, now: Date = new Date(), graceDays: number = DEFAULT_GRACE_DAYS): Entitlement {
  if (!input) return { active: false, reason: "no_subscription", until: null };
  const periodEnd = input.currentPeriodEnd ? Date.parse(input.currentPeriodEnd) : Number.NaN;
  const paidUntilFuture = !Number.isNaN(periodEnd) && periodEnd > now.getTime();

  switch (input.status) {
    case "active":
      return { active: true, reason: "active", until: input.cancelAtPeriodEnd ? input.currentPeriodEnd : null };
    case "trialing":
      return { active: true, reason: "trialing", until: input.currentPeriodEnd };
    case "past_due": {
      const since = input.pastDueSince ? Date.parse(input.pastDueSince) : Number.NaN;
      if (Number.isNaN(since)) return { active: true, reason: "grace_period", until: null };
      const end = since + graceDays * 24 * 60 * 60 * 1000;
      return end > now.getTime() ? { active: true, reason: "grace_period", until: new Date(end).toISOString() } : { active: false, reason: "payment_failed", until: null };
    }
    case "canceled":
    case "expired":
      return paidUntilFuture ? { active: true, reason: "paid_until_period_end", until: input.currentPeriodEnd } : { active: false, reason: "ended", until: null };
    case "paused":
      return { active: false, reason: "paused", until: null };
    case "incomplete":
      return { active: false, reason: "never_paid", until: null };
  }
}
