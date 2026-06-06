-- Migration: drop_deprecated_features
-- Deprecates and removes four features end-to-end: Financials (tuition plans,
-- invoices, invoice comments), Schedule, Parent Communication (messages), and
-- the standalone Feedback feature. Drops their backing tables.
--
-- NOTE: report_card_feedback and progress_report_feedback are SEPARATE,
-- surviving tables and are intentionally NOT dropped here.
--
-- Drop children-first within the financials FK chain
-- (tuition_invoice_comments -> tuition_invoices -> tuition_plans); CASCADE for safety.

DROP TABLE IF EXISTS tuition_invoice_comments CASCADE;
DROP TABLE IF EXISTS tuition_invoices CASCADE;
DROP TABLE IF EXISTS tuition_plans CASCADE;
DROP TABLE IF EXISTS feedback CASCADE;
DROP TABLE IF EXISTS schedules CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
