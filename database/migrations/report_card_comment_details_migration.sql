-- Report card comment details (2026-11-02): the optional picks and note a
-- teacher gives the AI that writes a student's report card comment. Never
-- printed and never shown to families; null means nothing picked.
-- Shape: { "picks": { "<item key>": "<option key>" }, "note": "<text>" }
-- (the list lives in the web's src/lib/reportCardDetails.ts).
ALTER TABLE report_card_feedback ADD COLUMN IF NOT EXISTS comment_details JSONB;
