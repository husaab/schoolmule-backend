// queries/paymentSettings.queries.js
//
// SQL for a school's payment settings (services/payments/taxSettings.js): its
// tax rates and the tax number on its receipts. Always scoped by school.

const paymentSettingsQueries = {
  /** Every rate, live ones first by name, then the archived ones. */
  selectRates: `
    SELECT tax_rate_id, name, rate_milli, archived_at
    FROM tax_rates
    WHERE school = $1
    ORDER BY (archived_at IS NOT NULL), lower(name), archived_at DESC NULLS FIRST, created_at
  `,

  selectRate: `
    SELECT tax_rate_id, name, rate_milli, archived_at
    FROM tax_rates
    WHERE tax_rate_id = $1 AND school = $2
  `,

  /** A live rate with this name (any case), other than $3. */
  selectLiveRateByName: `
    SELECT tax_rate_id, name FROM tax_rates
    WHERE school = $1 AND lower(name) = lower($2) AND archived_at IS NULL
      AND ($3::uuid IS NULL OR tax_rate_id <> $3::uuid)
    LIMIT 1
  `,

  insertRate: `
    INSERT INTO tax_rates (school, name, rate_milli, created_by)
    VALUES ($1, $2, $3, $4)
    RETURNING tax_rate_id
  `,

  updateRate: `
    UPDATE tax_rates SET name = $3, rate_milli = $4, updated_at = now()
    WHERE tax_rate_id = $1 AND school = $2
    RETURNING tax_rate_id
  `,

  /** Archives a rate; one already archived keeps the date it was removed. */
  archiveRate: `
    UPDATE tax_rates SET archived_at = COALESCE(archived_at, now()), updated_at = now()
    WHERE tax_rate_id = $1 AND school = $2
    RETURNING tax_rate_id
  `,

  selectSettings: `
    SELECT tax_number FROM payment_settings WHERE school = $1
  `,

  upsertTaxNumber: `
    INSERT INTO payment_settings (school, tax_number, updated_by, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (school) DO UPDATE SET tax_number = EXCLUDED.tax_number, updated_by = EXCLUDED.updated_by, updated_at = now()
  `,
};

module.exports = paymentSettingsQueries;
