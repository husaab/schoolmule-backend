-- ============================================================================
-- Email sender migration (one Resend team, per-school sender identity)
--
-- Purpose: move the "which domain does this school send from" rule out of a
-- hard-coded switch in utils/emailUtils.js and into the schools table, and
-- give every school a Reply-To list so parents who hit "reply" reach a
-- person instead of an unread reports@ mailbox.
--
-- Run this in the Supabase SQL Editor BEFORE deploying the backend that
-- reads these columns. Safe to re-run (idempotent). The old code ignores the
-- new columns, so it is safe to run ahead of the deploy.
--
-- Columns
--   email_sending_domain  NULL  -> the school sends as "<name>" <local@schoolmule.ca>
--                         set   -> the school sends as "<name>" <academics@<domain>>
--                                  (the domain must be verified in the SchoolMule
--                                  Resend team first; see email_sender_alhaadi_domain.sql)
--   email_sender_local    local part used on the platform domain; NULL derives it
--                         from the slug ("al-haadi-academy" -> "alhaadiacademy")
--   email_reply_to        addresses parent replies go to; the school's contact
--                         email (schools.email) is always appended at send time
-- ============================================================================

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS email_sending_domain TEXT,
  ADD COLUMN IF NOT EXISTS email_sender_local   TEXT,
  ADD COLUMN IF NOT EXISTS email_reply_to       TEXT[] NOT NULL DEFAULT '{}';

-- Al Haadi: parent replies reach the school's admins. Editable afterwards in
-- Admin Panel -> School Settings. email_sending_domain stays NULL here on
-- purpose: it is set by email_sender_alhaadi_domain.sql once alhaadiacademy.ca
-- is verified in the SchoolMule Resend team.
UPDATE schools
   SET email_reply_to = ARRAY['majidashouaib@gmail.com', 'fatimabano04@gmail.com']
 WHERE school_code = 'ALHAADIACADEMY'
   AND cardinality(email_reply_to) = 0;
