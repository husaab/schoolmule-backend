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

Rows in `payment_accounts` are kept per Stripe mode, so a backend running with a test key only ever reads and writes test rows.
