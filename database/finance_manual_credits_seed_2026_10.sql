-- Run AFTER finance_manual_credits_migration.sql. Prepaid credits for two
-- subsidy families whose September prepayments sit unapplied in QuickBooks
-- (applied by hand later so they never land on the Al-Ma'arif invoice).
BEGIN;
INSERT INTO finance_manual_credits (school, school_year_id, family_id, month_key, amount, note, qbo_deposit_id)
SELECT f.school, f.school_year_id, f.family_id, v.month_key, v.amount, v.note, v.dep
FROM (VALUES
  ('4be68a2b-b1b5-4ba1-8ec9-3b3a768b851c'::uuid, '2026-10', 575.00, '$1,750 e-transfer in Sept covering Sept–Nov; Oct fully prepaid', '21624'),
  ('4be68a2b-b1b5-4ba1-8ec9-3b3a768b851c'::uuid, '2026-11', 200.00, 'Rest of deposit 21624; still owes $375 for Nov', '21624'),
  ('f7c2b4b8-8b1b-4db0-9d0c-17d248b1bc34'::uuid, '2026-10', 250.00, '$750 in Sept covering Sept–Nov; Oct fully prepaid', '21640'),
  ('f7c2b4b8-8b1b-4db0-9d0c-17d248b1bc34'::uuid, '2026-11',  50.00, 'Rest of deposit 21640; still owes $200 for Nov', '21640')
) AS v(family_id, month_key, amount, note, dep)
JOIN families f ON f.family_id = v.family_id AND f.school = 'ALHAADIACADEMY'
ON CONFLICT (family_id, month_key) DO UPDATE
  SET amount = EXCLUDED.amount, note = EXCLUDED.note, qbo_deposit_id = EXCLUDED.qbo_deposit_id, updated_at = now();
SELECT f.name, mc.month_key, mc.amount FROM finance_manual_credits mc JOIN families f USING (family_id) ORDER BY 1, 2;
COMMIT;
