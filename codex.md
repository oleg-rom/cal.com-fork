# Codex Agent Instructions — `cal.com-fork`

## 1) Role and Objective

**Role:** DevOps-aware application engineer working in the Cal.com application fork.
**Primary objective:** Maintain a clean fork that tracks upstream Cal.com while enabling **custom changes** (e.g., Stripe Checkout) in **feature branches**, and producing **versioned Docker images** via CI for downstream deployment.

## 2) Canonical Architecture Context

- This repository contains **Cal.com application source code** plus custom modifications.
- **CI builds Docker images** from this repo and **pushes to GHCR**.
- The production server **never builds**; it only pulls images built here.

## 3) Branch Strategy and Change Control (Non-Negotiable)

### DO

- Treat `main` as a **clean upstream-tracking branch**.
- Perform **all custom app feature work** in **feature branches** (or short-lived integration branches if needed).
- Use `main` for **fork maintenance changes** that keep CI/build/deploy working (workflows, build scripts, docs) as long as they do **not** modify application code or introduce custom product features.
- Keep feature branches **small, reviewable, and focused** on a single change/theme.
- Rebase or merge upstream into feature branches as needed to keep them current (choose the method consistent with repo practice; do not invent a new flow without explicit direction).

### DO NOT

- **Never commit directly to `main`** without explicit user approval.
- **Never merge PRs into `main`** that contain custom app features.
- Never force-push to `main`.
- Never rewrite history of `main` or otherwise diverge `main` from upstream.

## 4) Upstream Handling Rules

### DO

- Keep the fork aligned with the upstream repository (`calcom/cal.com`) by regularly syncing `main` to upstream.
- Ensure upstream sync operations preserve the invariant: **`main` tracks upstream** and remains free of custom features.
- When upstream introduces changes affecting custom work, update feature branches accordingly (resolve conflicts, update integrations, adjust patches).

### DO NOT

- Do not “patch” upstream changes directly on `main`.
- Do not carry long-lived custom divergence on `main`.

## 5) CI Responsibilities (Fork Repo)

### DO

- Ensure CI is responsible for:
  - Building Docker images from this source tree.
  - Publishing images to **GHCR**.
  - Producing immutable image versions suitable for production use.
- Ensure CI outputs provide clear traceability:
  - Source commit → image tag → deployable artifact.

### DO NOT

- Do not shift build responsibilities to the server or the deploy repo.
- Do not add CI behaviors that require manual intervention on the server.

## 6) Image Tagging and Versioning (Non-Negotiable)

### DO

- Use **immutable tags** for all images.
- Use **git SHA tags** as the primary deploy/rollback identifier.
- Ensure tagging strategy supports:
  - Deterministic rollbacks
  - Auditable provenance
  - No ambiguity about what code is running

### DO NOT

- **Do not use `latest` tags** anywhere.
- Do not use mutable tags that can be repointed to different builds without a new identifier.

## 7) Separation of Concerns with `cal.com-deploy`

### DO

- Treat this repo as the **only source of truth for application code and image build inputs**.
- Communicate required runtime configuration changes (env vars, ports, migrations requirements, etc.) to the deploy repo via documentation or explicit change notes.

### DO NOT

- Do not introduce deployment-only files as the primary mechanism of running production (compose files, host Nginx config, server scripts) unless explicitly required for CI build context.
- Do not embed server-specific secrets or environment values in this repo.

## 8) Security and Secret Handling

### DO

- Keep secrets out of git history and out of repo files.
- Use CI secret stores / protected variables as appropriate (implementation details belong elsewhere; follow existing practice).

### DO NOT

- Do not commit API keys, private certificates, tokens, or production `.env` content.

## 9) What Codex Must Never Do in This Repo (Hard Prohibitions)

- Modify, commit to, merge into, or force-push `main` **without explicit user approval**.
- Introduce or rely on Docker image tags named `latest`.
- Implement “build on server” patterns (Compose build, remote Docker builds, ad-hoc host compilation).
- Move deployment ownership into this repo (compose as the production authority, host Nginx config as the runtime authority).
- Add undocumented coupling to the deploy repository (assumptions about file paths, server users, or host configuration not explicitly stated elsewhere).

## 10) Output Expectations When Working in This Repo

When proposing or executing changes, Codex must:

- State which branch is being used and why.
- Confirm whether changes target `main` or a feature branch, and why.
- Confirm CI-built image traceability (commit SHA → GHCR tag).
- Identify any downstream deploy repo updates required (without implementing them unless asked).

---

## Session Log: Stripe Direct Account Feature (2026-01-22)

### Goal
Enable PayPal and all Stripe payment methods by switching from Stripe Connect (connected accounts) to direct Stripe account integration.

### Background
- Cal.com's default Stripe integration uses Stripe Connect (OAuth flow with connected accounts)
- PayPal was rejected on the connected account ("your application did not meet paypal's criteria")
- PayPal works fine on the main/platform Stripe account
- Solution: Modify code to use main Stripe account directly instead of connected accounts

### Branch
`feature/stripe-direct-account` — custom app feature, per codex.md rules

### Commits

1. **`d60256806`** — `feat(stripe): use direct Stripe account instead of Connect`
   - **Files changed:**
     - `packages/app-store/stripepayment/lib/PaymentService.ts`
     - `packages/app-store/stripepayment/lib/customer.ts`
     - `packages/app-store/stripepayment/lib/server.ts`
   - **Changes:**
     - Removed all `stripeAccount` parameters from Stripe API calls
     - Updated `retrieveOrCreateStripeCustomerByEmail()` to not require `stripeAccountId`
     - Removed `stripeAccount` from `StripePaymentData` type
     - Made `stripe_user_id` optional in credential schema (backward compatibility)
   - **Build:** ✅ Success (Run ID `21242635968`)

2. **`96a499867`** — `fix(stripe): remove STRIPE_CLIENT_ID requirement for direct mode`
   - **Files changed:**
     - `packages/app-store/stripepayment/_metadata.ts`
   - **Changes:**
     - Removed `STRIPE_CLIENT_ID` from the `installed` check
     - App now shows as installed with only `STRIPE_PRIVATE_KEY` and `NEXT_PUBLIC_STRIPE_PUBLIC_KEY`
   - **Build:** ✅ Success (Run ID `21245150524`, 30m6s)

3. **`a048883d0`** — `fix(stripe): use platform public key for payment form`
   - **Files changed:**
     - `packages/app-store/stripepayment/lib/PaymentService.ts`
   - **Changes:**
     - Use `NEXT_PUBLIC_STRIPE_PUBLIC_KEY` from environment instead of credential's `stripe_publishable_key`
     - Made `stripe_publishable_key` optional in credential schema
     - Fixes payment window not opening (wrong publishable key was being passed to Stripe.js)
   - **Build:** ✅ Success (included in Run ID `21254678834`)

4. **`130e7f8f5`** — `ci: add concurrency control to prevent duplicate builds`
   - **Files changed:**
     - `.github/workflows/docker-build-push-ghcr.yml`
   - **Changes:**
     - Added concurrency group to cancel older workflow runs when a new push happens
     - Prevents wasteful duplicate builds
   - **Build:** ✅ Success (Run ID `21254678834`, 30m7s)

5. **`800642688`** — `feat(stripe): use Stripe Checkout for payments with automatic tax support`
   - **Files changed:**
     - `packages/app-store/stripepayment/lib/PaymentService.ts`
     - `packages/features/ee/payments/api/webhook.ts`
     - `packages/features/ee/payments/pages/payment.tsx`
   - **Changes:**
     - Switched from embedded Payment Element to Stripe hosted Checkout page
     - Added `automatic_tax: { enabled: true }` for Stripe Tax support
     - Payment page now redirects to Stripe Checkout URL
     - Added webhook handler for `checkout.session.completed` event
     - Added `STRIPE_DIRECT_MODE` env var for webhook processing in direct mode
   - **Build:** ✅ Success (Run ID `21256214648`, 32m21s)

### Build Status
- **Latest build:** Run ID `21256214648` (commit `800642688`)
- **Status:** ✅ Success
- **Image tag:** `ghcr.io/oleg-rom/cal.com-fork:sha-800642688`

### Testing Results
- ✅ Payment form opens correctly
- ✅ Stripe Checkout page loads with all payment methods
- ✅ PayPal works on Stripe Checkout
- ✅ Automatic tax calculation works (Stripe Tax)
- ✅ Webhooks processed correctly in direct mode

### Environment Variables for Deployment
When using this feature branch, configure these env vars with your **main** Stripe account (not connected):
- `STRIPE_PRIVATE_KEY` — Main account secret key (`sk_live_...` or `sk_test_...`) — **Required**
- `NEXT_PUBLIC_STRIPE_PUBLIC_KEY` — Main account publishable key (`pk_live_...` or `pk_test_...`) — **Required**
- `STRIPE_WEBHOOK_SECRET` — Webhook secret for main account (`whsec_...`) — **Required for webhooks**
- `STRIPE_DIRECT_MODE=true` — **Required** for webhook processing in direct mode
- `STRIPE_CLIENT_ID` — **Not needed** (only used for Connect OAuth, can be omitted)

### Post-Deployment Configuration Changes

#### Username Change
- Changed username from `inga` to `session` via database:
  ```sql
  UPDATE "users" SET username = 'session' WHERE username = 'inga';
  ```
- Event URLs now follow pattern: `booking.inga.life/session/{event-slug}`

#### Admin Password Warning Fix
- **Issue:** Orange warning banner showing "Change your password to access Admin features"
- **Cause:** User role was set to `INACTIVE_ADMIN` in database
- **Fix:** Updated role to `ADMIN`:
  ```sql
  UPDATE "users" SET role = 'ADMIN' WHERE username = 'inga';
  ```
- **Session refresh:** User logged out and back in for session to pick up new role
- **Result:** ✅ Banner removed successfully

6. **`cfdb41d94`** — `feat(i18n): customize email templates for INGA LIFE branding`
   - **Files changed:**
     - All 44 locale files in `apps/web/public/static/locales/*/common.json`
   - **Changes:**
     - Updated `happy_scheduling` from "Happy scheduling" to localized "See you soon!" / "До встречи!" etc.
     - Updated `the_calcom_team` to "Команда INGA LIFE" in all locales
     - Email verification subject uses `{{appName}}` variable (configured via `NEXT_PUBLIC_APP_NAME` env var)
   - **Build:** ✅ Success

7. **`(pending)`** — `feat(ui): add timezone hint and remove Cal.com branding`
   - **Files changed:**
     - `apps/web/modules/bookings/components/EventMeta.tsx`
     - `packages/emails/src/components/EmailBodyLogo.tsx`
     - `packages/emails/templates/confirm-email.html`
   - **Changes:**
     - Added timezone hint message on booking pages (Russian text)
     - Removed Cal.com logo from all email templates
     - Updated confirm-email.html with INGA LIFE branding
   - **Build:** ⏳ Pending

### Related Previous Work
- `feature/stripe-all-payment-methods` branch — Earlier attempt that kept Connect but enabled `automatic_payment_methods`. PayPal still didn't work due to connected account restrictions.
