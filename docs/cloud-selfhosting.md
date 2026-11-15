# Running Agent Review Desk Cloud

한국어: [cloud-selfhosting.ko.md](cloud-selfhosting.ko.md)

The cloud server is the paid **Team** tier: an account system, team workspaces that hold synced sessions, roles,
single sign-on, and billing. It is a Next.js app (`apps/cloud`) on top of `@ard/cloud` and `@ard/billing`.

> **Honest status.** The server, the CLI commands (`ard login` / `sync`), roles, SSO and both billing integrations are
> built and tested, including an end-to-end run with the real server, the real CLI, signed webhooks and real OIDC
> redirects. What has **not** been done from here is a live payment with your Paddle or Dodo account, and a
> live sign-in with a real identity provider. Section 7 is the checklist for that.

## 1. What you need

- Node.js 22.13 or newer.
- A server with a **persistent disk** and a **single instance**. Data is SQLite (one control database plus one file per
  organization), which is simple and fast but not shared between several servers. Scaling out needs a Postgres
  implementation of the repository layer; that is not written yet.
- HTTPS in front of it (Caddy, nginx, a platform's load balancer). Paddle and every identity provider require it.
- An OpenID Connect provider for sign-in (Google works), and a Paddle and/or Dodo Payments account.

## 2. Build and run

```bash
git clone https://github.com/Trapa-Eureka/agent-review-desk.git
cd agent-review-desk
pnpm install
pnpm build
# set the environment (see apps/cloud/.env.example), then:
pnpm --filter @ard/cloud-web start        # listens on 127.0.0.1:4780; put your HTTPS proxy in front
```

The server lists every configuration problem at once on its home page if the environment is incomplete, and refuses to
run with insecure combinations (plain-http public URL, dev login on a real host).

## 3. Environment

See `apps/cloud/.env.example`: every variable is documented there. The essentials are `ARD_CLOUD_SECRET`,
`ARD_CLOUD_BASE_URL`, `ARD_CLOUD_DATA_DIR`, the `ARD_CLOUD_LOGIN_*` provider, and the `ARD_PADDLE_*` / `ARD_DODO_*` groups.

Behind a reverse proxy set `ARD_CLOUD_TRUST_PROXY=1` (the number of proxy hops; `2` for a CDN plus a proxy) so rate limits
count real client addresses. The address is read from the **right** end of `X-Forwarded-For`, where your own proxy
appended it: whatever the client wrote further left is ignored, so it cannot choose its own rate-limit key. Without the
setting the header is ignored and every client shares one bucket (safe against spoofing, but one noisy client can use up
everyone's sign-in allowance). Never set it when no proxy is in front.

## 4. Sign-in

Register this redirect URI with your OpenID Connect provider: `https://<your host>/api/auth/callback`. Users sign in with
that provider; accounts are keyed by the provider's stable subject id and require a **verified** e-mail address.

Organizations can add their own **single sign-on** (Settings > Single sign-on, owners only): any OpenID Connect provider
(Okta, Microsoft Entra ID, Google Workspace, Auth0). SAML is not supported. People who sign in through a company's SSO
become accounts **scoped to that organization**: they are never merged with a personal account that has the same e-mail
(otherwise a company's IdP could claim someone else's address and take their account over), and they cannot create or
join other organizations.

## 5. Payments

The plan is one monthly **Team** subscription per organization. **The code contains no price.** The server asks the
provider to charge whatever price is attached to the product you create below, so you choose (and can later change) the
amount in the provider's dashboard. Changing a price affects **new subscribers only**; existing subscriptions keep the
price they started with (true for both providers).

Both integrations default to **sandbox / test mode**, and in both providers sandbox and live are completely separate
(products, prices, keys, webhooks, secrets). Always build and test in sandbox first, then repeat the setup for live
(section 5.3). You can configure one provider or both; owners see a Pay button for each configured one.

Everything below was checked against each provider's official documentation (November 2026). Dashboards change; where a
label could not be confirmed it says so. If your screen differs, follow the provider's current docs.

### 5.1 Paddle

#### Step 1. Create a sandbox account

A sandbox account is separate from your live account, even if you already have one: sign up at
<https://sandbox-vendors.paddle.com/signup>. It needs no verification and no real money. Everything in 5.1 is done in the
**sandbox** dashboard first.

#### Step 2. Create the product

1. Go to **Paddle > Catalog > Products** and click **New product**.
2. Fill in: **Product name** (required, e.g. `Agent Review Desk Team`), **Tax category** (pick `SaaS`; `standard` and `saas` exist
   on every account), and an optional **Description**.
3. Click **Save**.

#### Step 3. Create the monthly price (this is what the server uses)

1. Open the product, find the **Prices** section, click **New price**.
2. Fill in:
   - **Base price** (required): the amount and currency (start with USD).
   - **Tax**: leave **Default** (uses your account's sales-tax setting, see step 4).
   - **Type**: **Recurring**. A one-time price does not create a subscription, so billing would never start.
   - **Billing period**: **Monthly**.
   - **Trial period**: `0` for no trial. A free or paid trial is optional; the server treats `trialing` as paid access.
   - **Price name** (shown at checkout and on invoices, e.g. `Team, monthly`) and an internal description.
3. Click **Save**.
4. Copy the **price** id: click the `...` menu next to the price and choose **Copy price ID**. It starts with `pri_`.
   Do **not** copy the product id (`pro_...`). Put it in `ARD_PADDLE_PRICE_ID`.

The server buys quantity 1 of this price, so one organization = one subscription.

#### Step 4. Choose how tax is shown (once per account)

**Paddle > My account > Settings > Sales tax**: prices exclusive of tax, inclusive of tax, or set automatically from the
customer's location. This applies to prices whose Tax is `Default`. Paddle is the merchant of record and handles the
sales tax or VAT itself.

#### Step 5. Create the API key

1. **Paddle > My account > Settings > Authentication**, tab **API keys**, **New API key**.
2. Enter a name and description, choose the **permissions**, set an **expiry date**, and leave **Rotatable** off unless you
   plan to rotate keys with Paddle's API or a secrets manager (it cannot be changed after creation).
3. **Save**, then copy the key. **It is shown only once.** If you lose it, revoke it and create a new one.

Permissions to select (grant only these): `transaction.write` (creates the checkout), `customer_portal_session.write`
(opens the billing portal), plus the read permissions `transaction.read`, `price.read`, `product.read`, `customer.read`
and `subscription.read`. Write includes read. If the server later logs a `forbidden` (403) from Paddle, the key is
missing a permission: edit the key and add it (calling Paddle's API root with the key shows `caller.permissions`).

Sandbox keys look like `pdl_sdbx_apikey_...`, live keys `pdl_live_apikey_...`. A sandbox key against the live API (or the
reverse) fails with `forbidden`. Put the key in `ARD_PADDLE_API_KEY`, server side only. **Put the expiry date in your
calendar**: when a key expires, Pay buttons start failing.

#### Step 6. Create the client-side token

Same page, tab **Client-side tokens**, **New client-side token**: enter a name, **Save**, then click the `...` button next to
it and choose **Copy**. Sandbox tokens start with `test_`, live tokens with `live_`. Put it in `ARD_PADDLE_CLIENT_TOKEN`.
It is safe to expose in a web page (it can only open checkouts and preview prices). **Never put an API key here.**

#### Step 7. Approve your domain and set the default payment link

Paddle only opens a checkout from an approved domain, and creating a transaction fails until a default payment link
exists. This server's checkout page is `https://<your host>/pay`.

1. **Paddle > My account > Settings > Website approval > Add a new domain**: enter your host name, **Submit for approval**.
   Sandbox approves it instantly; live review takes a few days.
2. **Paddle > Checkout > Checkout configuration**, heading **Default payment link**: enter `https://<your host>/pay`, **Save**.
   It must be `https`, on your own domain, **not `localhost`**. In live accounts the host must match an approved domain
   exactly (or its `www.` form): `app.example.com` needs its own approval even if `example.com` is approved.

Testing before you have a public host: the default payment link cannot be `localhost`, so use a tunnel (Cloudflare Tunnel,
ngrok, ...) that gives your local server a public https address, and use that address as `ARD_CLOUD_BASE_URL` and in
both settings above. The checkout itself does open on `localhost` in sandbox.

The `/pay` page loads Paddle.js from `cdn.paddle.com` and embeds Paddle's checkout frame, so that page alone has a wider
Content-Security-Policy that allows `*.paddle.com`. Paddle does not publish an official CSP list, so the pattern is
deliberately broad on that one page. **Check in sandbox that the checkout opens**, and tighten it if you can.

#### Step 8. Create the webhook (notification destination)

1. **Paddle > Events > Notifications > New destination**.
2. **Description**: anything (e.g. `Agent Review Desk`). **Notification type**: **Webhook**.
3. **URL**: `https://<your host>/api/webhooks/paddle`. Leave **API version** at its default and usage type at **platform**
   (real events only).
4. **Events**: select exactly these eight: `subscription.created`, `subscription.activated`, `subscription.trialing`,
   `subscription.updated`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`,
   `subscription.canceled`. (Other event types are acknowledged and ignored; selecting all also works, it just adds noise.)
5. **Save destination**.
6. Open the destination again (`...` menu > **Edit destination**) and copy the **Secret key** (`pdl_ntfset_...`) into
   `ARD_PADDLE_WEBHOOK_SECRET`.

Do not delete and recreate a destination later: that gives it a **new** secret and every delivery fails verification
until you update the server. At most 10 destinations can be active at once. Each destination (sandbox and live) has its
own secret.

#### Step 9. Test in sandbox

Restart the server with the sandbox values, then follow section 7. At the Paddle checkout use the test card
`4242 4242 4242 4242`, any future expiry date, security code `100`, an email address you own, and any valid country and
postal code. The Billing page should turn to **Team** within about a minute (that is the webhook arriving). Paddle's
notification simulator can also replay events at your endpoint.

### 5.2 Dodo Payments

#### Step 1. Know the two modes

The dashboard has a **Live Mode** switch in the sidebar. Test mode and live mode are separate for **products, API keys and
webhooks** (a product can be copied from test to live later). Business profile, bank account and verification documents are
shared. A key from one mode returns 401 on the other mode's host (`test.dodopayments.com` / `live.dodopayments.com`;
the server picks the host from `ARD_DODO_ENV`).

Two things to know about test mode: subscriptions created in test mode **keep renewing** until cancelled (cancel through
the Update Subscription API with `status: "cancelled"` using the test key), and test mode sends **real emails** (subject
prefixed `[TEST MODE]`), so use addresses you own.

Choose your account type when you sign up: **Individual** (creator or sole proprietor; the docs say no company registration or
business tax ID is needed) or **Registered Entity**. Only live payments need verification (5.3); test mode works at once.

#### Step 2. Create the subscription product

1. Switch the dashboard to **test mode**, open **Products**, and create a new product (the exact button label was not
   confirmed in the docs).
2. **Pricing Type**: **Subscription** (not Single Payment, not Usage Based Billing).
3. Fill in the fields:
   - **Product Name** (required, e.g. `Agent Review Desk Team`); description, image and brand are optional.
   - **Tax Category** (required): pick `SaaS`.
   - **Price** (required): the monthly amount and currency. The minimum non-zero subscription price is $1.00 USD. Check the
     amount the dashboard shows back to you (whether the field takes dollars or cents was not confirmed in the docs).
   - **Repeat payment every**: `1` **Month**.
   - **Subscription Period** (required): the total term. Use **20 years** (the maximum, and the recommended value).
     **If this equals the payment frequency, the subscription expires after one charge**, which would cut access off after
     the first month.
   - **Trial Period Days** (required): `0` for no trial.
   - Leave **Card-optional at $0 Price**, add-ons and entitlements empty. Leave **Discount**, **Trial Amount** and **Tax
     Inclusive Pricing** at their defaults unless you want them.
4. Save. Open **Products > View Details** and copy the product id (`pdt_...`) into `ARD_DODO_PRODUCT_ID`.

The server buys quantity 1 of this product, so one organization = one subscription.

#### Step 3. Create the API key

1. **Developer > API Keys > Create New Key** (in test mode for now).
2. Enter a **Key Name**, then set access per resource to **None / Read / Write**. The docs do not say which resources the
   checkout and portal calls need, so start with: **Payments: Write**, **Subscriptions: Read**, **Products: Read**,
   **Customers: Write**, everything else **None**. If the server logs a 401/403 from Dodo, open **Edit Permissions** and
   add what the error names.
3. **IP Allowlist** is optional (up to 20 addresses or CIDR ranges). Leave it empty unless your server has fixed outgoing
   addresses; a wrong allowlist makes every Pay button fail.
4. Create it and copy the key immediately: **it is shown only once.** Test keys start with `dodo_test_`, live keys with
   `dodo_live_`. Put it in `ARD_DODO_API_KEY`.

#### Step 4. Create the webhook endpoint

1. **Developer > Webhooks > Add endpoint**.
2. **Endpoint URL**: `https://<your host>/api/webhooks/dodo` (must be https).
3. **Events**: select exactly these ten under `subscription`: `subscription.active`, `subscription.renewed`,
   `subscription.unpaused`, `subscription.plan_changed`, `subscription.past_due`, `subscription.on_hold`,
   `subscription.paused`, `subscription.cancelled`, `subscription.expired`, `subscription.failed`.
   **Do not leave the list empty**: Dodo then sends every event type. Do not add `subscription.updated` or
   `subscription.update_payment_method`: the server does not use them, and a subscription event it cannot classify may be treated
   as no access.
4. **Create endpoint**, then open its **Overview** tab and copy the signing secret (`whsec_...`) into
   `ARD_DODO_WEBHOOK_SECRET`. **Rotate secret** is on the same tab; the old secret stays valid for 24 hours.

Dodo gives each delivery 30 seconds and up to 8 attempts, and the endpoint's **Logs** tab can replay events. The
**Testing** tab has **Send example**.

#### Step 5. Return address

The server creates each checkout with a return address (your Billing page); Dodo sends the buyer back there after payment
with the status in the URL. The server does not trust that URL for access: only the signed webhook changes the plan. The
docs list no allowed-domains setting for checkout sessions. If a checkout is ever refused because of its return address, contact
Dodo support and tell them the address the server sent. A checkout link is single-use and expires after 24 hours.

#### Step 6. Test in test mode

Restart the server with the test values and follow section 7. Use the test card numbers from Dodo's testing documentation.
Confirm the Billing page turns to **Team**, and cancel the test subscription afterwards (see step 1).

### 5.3 Going live (both providers)

Do this only after a complete sandbox / test-mode run (section 7). Live accounts are separate: recreate everything.

**Both providers need a public website** that shows the price, **Terms of Service**, **Privacy Policy**, a **Refund and
cancellation policy** and a contact route. **This server does not provide those pages: you publish them on your site.**
Prices on the site must match the catalog. Both providers review the site before live payments are allowed.

**Paddle**

1. Complete account verification: **Paddle > Get started > Verify your account** (an administrator does this). Paddle asks
   for your personal details (including date of birth and home address), your business's legal name and address, your
   website and what you sell. Verification usually takes about 10 minutes but can take days. Paddle asks for *business*
   details and the docs do not say what applies to someone without a registered business: ask Paddle before relying on
   it. Whether you must register a business or collect tax is for you and a tax adviser.
2. Submit each domain under **Website approval** (live review takes days; it can run in parallel with verification).
3. Recreate the product and monthly price in the **live** dashboard (ids differ; note the mapping), create a **live** API key
   and **live** client-side token (`live_...`), and a **live** notification destination (new secret).
4. Set the live **default payment link** to `https://<your host>/pay` once the domain is approved.
5. Add bank details: **Business account > Payouts > Payout settings**.
6. Set `ARD_PADDLE_ENV=production` with the **four** live values (API key, price id, client token, webhook secret), restart,
   and make one real purchase yourself (a 100% discount code makes it free).

**Dodo Payments**

1. Complete the forms for your account type in the dashboard: Individual = **Product Information > Identity Verification
   (KYC) > Bank Verification**; Registered Entity adds business verification. Product Information asks for your public site
   (with the pages above) and a description of what you sell. KYC is a government photo ID plus a selfie (3 attempts) and the ID must
   be from a country on Dodo's accepted list: **check that your country is on it before you start**. The bank account
   name must match your verified identity. Review typically takes 1-3 business days; payouts also need a completed
   monitoring review.
2. Switch the dashboard to **live mode** and copy the product from test mode (or recreate it); note the new `pdt_` id.
3. Create a **live** API key and a **live** webhook endpoint (new `whsec_` secret).
4. Set `ARD_DODO_ENV=live_mode` with the **three** live values (API key, product id, webhook secret), restart, and make
   one real purchase yourself.

After switching, cancel and refund your own test purchase in the provider's dashboard.

### 5.4 How a payment becomes access

Owners click **Pay with Paddle / Dodo Payments** on the Billing page. The server creates the checkout with a one-time
random value that the provider returns in its subscription webhooks; **that value, never an id taken from the webhook
body, is what ties a payment to an organization.** Webhooks are verified against the exact bytes received (Paddle:
HMAC-SHA256 of `ts:body`; Dodo: Standard Webhooks), are idempotent (redelivery changes nothing), and tolerate out-of-order
delivery (an older event never overwrites a newer one). Anything not signed correctly gets 400 and changes nothing. A subscription that two organizations both claim is answered **409** (a failed delivery in the provider's dashboard) and written to the audit log, so someone looks at it. A late event about an **old, replaced** subscription never switches off the one the team now pays for.

Access rules: `active` / `trialing` = paid features on; a failed payment keeps access for **7 days** from the first
failure; a cancelled subscription keeps access until the paid period ends; paused or never-completed = off. When access
lapses, **uploads and reviews stop but everything already synced stays readable**: lapsing never holds data hostage.

Refunds, chargebacks and plan changes are handled in the provider's dashboard and arrive as subscription updates.

## 6. Operating it

- **Back up `ARD_CLOUD_DATA_DIR`** (stop the server or use SQLite's `.backup`). It holds accounts, billing state and all
  synced sessions.
- **Logs**: rejected webhooks log their reason (never the body); unexpected errors are logged with a stack trace.
- **Health**: `GET /api/health` for uptime checks.
- **Secret rotation**: changing `ARD_CLOUD_SECRET` makes stored SSO client secrets unreadable; owners are told to save the
  SSO settings again. Nothing else depends on it.
- **Limits**: 500 events / 4 MiB per upload, per-organization storage quota (default 1 GiB), upload and sign-in rate
  limits (in memory: a restart resets them).
- **Retention**: synced data is kept until you delete it. There is no automatic expiry yet.

## 7. First live test (what to check yourself)

1. Sandbox: sign in, create an organization, press **Pay with Paddle**, complete a sandbox purchase, confirm the Billing
   page shows **Team** within a minute (the webhook), then `ard login` and `ard sync` from a project.
2. Cancel in the billing portal and confirm "paid until period end" appears and sync keeps working until then.
3. Repeat with Dodo (test mode) if you offer it.
4. Configure a real identity provider for sign-in and (optionally) one organization's SSO, in a private browser window.
5. Only then switch `ARD_PADDLE_ENV=production` / `ARD_DODO_ENV=live_mode` with live credentials and approved domains.

## 8. Security model in short

- Sessions: random ids stored only as hashes; `HttpOnly`, `SameSite=Lax`, `Secure` (and `__Host-` prefixed) over https.
- State-changing requests must come from this site: `Sec-Fetch-Site` must say so **and** any `Origin` must match (with `Origin` alone as the
  fallback for non-browser clients).
- Signing in is bound to the browser that started it (a short-lived cookie holding the sign-in `state`), so a callback link
  cannot be used to sign someone else's browser in to an attacker's account (login CSRF).
- The page headers deliberately have no `form-action` directive: Chrome applies it to the redirect after a form post, and sign-in,
  SSO and checkout are form posts answered by a redirect to another site.
- API tokens (`ard_...`) are random, stored hashed, shown once, revocable, and checked against organization membership on
  every request.
- The server fetches URLs that customers type (an SSO issuer). It refuses non-https, redirects, oversized responses, and any
  address that is not public (for IPv6 only global unicast is allowed, which also excludes every spelling of a mapped IPv4
  address), and it then connects to the address it checked rather than resolving the name again (no DNS rebinding).
- ID tokens must be signed with RS256 or ES256 by the provider's published keys; `none` and HMAC algorithms are refused.
- Every organization's sessions live in their **own SQLite file**, so no query can cross organizations.
- A session belongs to the member who first uploaded it; whole-session review decisions cannot be uploaded; uploaded text
  is redacted again on the server.

## 9. Known limits

- SQLite, single instance (see section 1). No SAML. No outgoing e-mail: invitation links are copied by hand.
- One flat Team plan per organization; no per-seat pricing yet.
- Pre-approval of risky actions (the local hook) is still local: approvals made in the cloud workspace are reviews of
  finished sessions, not live gates on an agent.
- No automatic data deletion or export tooling yet.
