import type { BillingEvent, BillingProvider, ProviderId } from "@ard/billing";
import { orgEntitlement } from "./auth.js";
import type { ControlStore, Org, User } from "./control.js";
import { randomToken } from "./crypto.js";
import { CloudError } from "./errors.js";

export type Providers = ReadonlyMap<ProviderId, BillingProvider>;

/**
 * Start a subscription checkout for an organization.
 *
 * A fresh random nonce is stored with the checkout and handed to the provider as custom data / metadata. When the
 * subscription webhook arrives, THAT is how it is tied to an organization: never an id read from the payload,
 * which anyone able to open a checkout could set to whatever they like.
 */
export async function startCheckout(control: ControlStore, providers: Providers, input: { org: Org; user: User; providerId: string; returnUrl: string; now?: Date }): Promise<{ url: string }> {
  const provider = providers.get(input.providerId as ProviderId);
  if (!provider) throw new CloudError("bad_request", "That payment method is not available on this server.");
  const current = orgEntitlement(input.org, input.now);
  if (current.active && input.org.subStatus === "active" && !input.org.subCancelAtPeriodEnd) {
    throw new CloudError("conflict", "This organization already has an active subscription. Use \"Manage subscription\" to change or cancel it.");
  }
  const nonce = randomToken(24);
  const checkoutId = control.createCheckout({ orgId: input.org.id, userId: input.user.id, provider: provider.id, nonce });
  const result = await provider.createCheckout({ nonce, email: input.user.email, ...(input.user.name ? { name: input.user.name } : {}), returnUrl: input.returnUrl });
  if (result.reference) control.setCheckoutReference(checkoutId, result.reference);
  control.audit(input.org.id, input.user.id, "billing.checkout_started", provider.id);
  return { url: result.url };
}

/** A link to the provider's hosted page where the customer updates the card, downloads invoices or cancels. */
export async function openBillingPortal(providers: Providers, input: { org: Org; returnUrl: string }): Promise<{ url: string }> {
  const { org } = input;
  if (!org.billingProvider || !org.billingCustomerId) throw new CloudError("not_found", "This organization has no subscription to manage yet.");
  const provider = providers.get(org.billingProvider);
  if (!provider) throw new CloudError("unavailable", "The payment provider for this subscription is not configured on this server.");
  return provider.createPortalSession({ customerId: org.billingCustomerId, ...(org.billingSubscriptionId ? { subscriptionId: org.billingSubscriptionId } : {}), returnUrl: input.returnUrl });
}

export type BillingOutcome =
  | { status: "applied"; orgId: string }
  | { status: "stale"; orgId: string }
  | { status: "duplicate" }
  | { status: "ignored" }
  | { status: "unmatched" }
  | { status: "conflict" };

/**
 * Apply a verified webhook to the organization it belongs to. Safe to call any number of times with the same
 * event (redelivery), and with events out of order (the older one is ignored).
 *
 * Every outcome except `conflict` is a success for the provider: it must get HTTP 200 or it will retry for days.
 * `unmatched` is normal: the same provider account may also sell products that have nothing to do with us.
 */
export function applyBillingEvent(control: ControlStore, event: BillingEvent): BillingOutcome {
  const snapshot = event.subscription;
  if (!snapshot) return { status: "ignored" };

  // Which organization? Only through records WE created, never through ids in the payload.
  const byNonce = snapshot.checkoutNonce ? control.findOrgIdByCheckoutNonce(snapshot.provider, snapshot.checkoutNonce) : null;
  const byReference = snapshot.transactionId ? control.findOrgIdByCheckoutReference(snapshot.provider, snapshot.transactionId) : null;
  const bySubscription = control.findOrgIdBySubscription(snapshot.provider, snapshot.subscriptionId);
  const fromCheckout = byNonce ?? byReference;
  if (fromCheckout && bySubscription && fromCheckout !== bySubscription) {
    control.audit(bySubscription, null, "billing.conflict", `${snapshot.provider} ${snapshot.subscriptionId} claimed by another checkout`);
    return { status: "conflict" };
  }
  const orgId = bySubscription ?? fromCheckout;
  if (!orgId) return { status: "unmatched" };

  return control.tx(() => {
    if (!control.recordBillingEvent(event.provider, event.eventId)) return { status: "duplicate" } as const;
    const applied = control.applySubscription(orgId, snapshot, event.occurredAt);
    if (applied) control.audit(orgId, null, "billing.subscription", `${snapshot.provider} ${snapshot.status}${snapshot.cancelAtPeriodEnd ? " (cancels at period end)" : ""}`);
    return { status: applied ? "applied" : "stale", orgId } as const;
  });
}
