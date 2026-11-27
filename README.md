# School Mule

## Table of Contents
1. [Installation](#installation)
2. [Usage](#usage)
3. [Contact](#contact)

## Installation
To launch, follow these steps:

1. **Clone the repository:**
    ```bash
    git clone https://github.com/husaab/schoolmule-backend.git
    cd schoolmule-backend
    ```

2. **Install dependencies:**
    ```bash
    npm install
    ```

3. **Run the application:**
    ```bash
    npm run dev
    ```

## Usage
Once the application is running, you can access it at `http://localhost:4000`. 



## Payments (Stripe)

Finance → Payments lets a school connect its own Stripe account (`services/payments`, `/api/payments`). Apply `database/migrations/payments_stripe_connect_migration.sql` first.

| Variable | Where | What it does |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | everywhere payments should work | The platform's Stripe secret key. Without it the Payments page says payments aren't switched on. Use a sandbox key (`sk_test_…`) on any machine that is not production. |
| `STRIPE_LIVE_ENABLED` | production only | Must be `true` for a live key (`sk_live_…`) to be accepted. A local backend uses the production database, so it must never run with a live key. |
| `STRIPE_API_VERSION` | optional | Overrides the pinned Stripe API version (`services/payments/stripeClient.js`). |
| `STRIPE_WEBHOOK_SECRET` | everywhere payments should work | The signing secret of the Stripe webhook endpoint (`whsec_…`). Comma-separate several when more than one endpoint sends here. Locally, `stripe listen --print-secret` prints the CLI's. |
| `PARENT_PAYMENTS_ENABLED` | off until launch | `true` turns on the parent portal's Payments page (`GET /api/parent-portal/payments`). Unset, the route answers 404. |

Families pay inside SchoolMule's own page when the web has `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (Stripe's embedded Checkout, `POST /api/registration/public/payments/:token/checkout` with `{ ui: 'embedded' }`); otherwise, and in the app, on Stripe's own page. For Apple Pay and Google Pay inside the page, the backend registers `FRONTEND_URL`'s domain on each school's Stripe account the first time it opens one there.

Stripe sends payment events from schools' accounts to a **Connected accounts** destination, and (with Accounts v2) a school account's own `account.updated` to a **Your account** destination. Both can point at the same URL: put both signing secrets in `STRIPE_WEBHOOK_SECRET`, separated by a comma.

Rows in `payment_accounts` are kept per Stripe mode, so a backend running with a test key only ever reads and writes test rows.

Tax: Finance → Payments → Settings keeps the school's tax rates and the tax number printed on receipts (`/api/payments/settings`, `/api/payments/tax-rates`; `services/payments/taxSettings.js`). Each form item or payment request names a rate (or none), added on top or included in the price; the math is in `services/payments/tax.js`, and every charge line keeps its own copy of the rate, so editing or removing one never changes a past payment. Removing a rate archives it. Apply `payments_tax_migration.sql` (it also adds `registration_form_submissions.entered_by`, for a payment the office records for a student whose family never sent the form: `POST /api/registration/forms/:formId/office-payments`).

Stripe's webhook is `POST /api/payments/stripe/webhook` (no JWT; the signature over the raw body is the proof). It stores each event once in `stripe_events` and answers at once; `services/payments/paymentsWorker.js` acts on it, retries failures with backoff, and once a day re-reads every connected school's account. Apply `payments_stripe_events_migration.sql` too.

In Stripe, create one endpoint at that URL listening to **events on connected accounts**. To try it locally:

```sh
stripe listen --events account.updated,account.application.deauthorized,checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,charge.refunded,charge.refund.updated,charge.dispute.created,charge.dispute.closed \
  --forward-to http://localhost:4000/api/payments/stripe/webhook --forward-connect-to http://localhost:4000/api/payments/stripe/webhook
```
