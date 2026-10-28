-- ============================================================================
-- Every school sends from SchoolMule's role addresses
--
-- Purpose: parents get school email from "<School name>" <academics@schoolmule.ca>
-- (report cards, grades, certificates) and "<School name>" <messages@schoolmule.ca>
-- (messages, announcements, classroom notices) instead of a per-school address.
-- Both are aliases on info@schoolmule.ca in Google Workspace, so Gmail shows
-- info@'s SchoolMule profile photo beside them, and a parent who writes to
-- them directly reaches info@. Replies still go to the school's reply-to list.
--
-- Run this in the Supabase SQL Editor AFTER deploying the backend that sends
-- from the role addresses. Before that deploy, a school without a domain sends
-- from <slug>@schoolmule.ca, which has no alias. Safe to re-run (idempotent).
--
-- Columns
--   email_sending_domain  cleared for every school. The backend still honours it,
--                         so setting it again (after verifying the domain in the
--                         SchoolMule Resend team) moves that school back to
--                         academics@<domain> and messages@<domain>.
--   email_sender_local    no longer read by the backend. Left in place.
-- ============================================================================

UPDATE schools
   SET email_sending_domain = NULL
 WHERE email_sending_domain IS NOT NULL;
