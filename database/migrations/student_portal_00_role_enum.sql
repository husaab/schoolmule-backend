-- Student portal, phase 0: the STUDENT role.
-- Its own file and NOT inside BEGIN/COMMIT: Postgres cannot use an enum value
-- in the transaction that added it, and nothing here needs to.
ALTER TYPE role ADD VALUE IF NOT EXISTS 'STUDENT';
