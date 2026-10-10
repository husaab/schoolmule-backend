-- ============================================================================
-- Al Haadi custom sending domain (step 4 of the Resend consolidation cutover)
--
-- Run this ONLY AFTER alhaadiacademy.ca shows "Verified" in the SchoolMule
-- Resend team (Domains page). Until then Al Haadi sends from
-- "Al Haadi Academy" <alhaadiacademy@schoolmule.ca>, which needs no DNS.
--
-- After it is verified, parents receive from academics@alhaadiacademy.ca and
-- messages@alhaadiacademy.ca again. To go back to the platform address at any
-- time, set email_sending_domain back to NULL.
-- ============================================================================

UPDATE schools
   SET email_sending_domain = 'alhaadiacademy.ca'
 WHERE school_code = 'ALHAADIACADEMY';
