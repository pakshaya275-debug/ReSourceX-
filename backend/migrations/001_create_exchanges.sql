-- Compatibility note: the original v1 exchange table used a denormalized layout.
-- For a new database, run backend/schema.sql.
-- For an existing database, back up first and run backend/migrations/phase5_enhancements.sql.
-- That migration upgrades the old layout and preserves existing resource links.
-- This file is intentionally a no-op so it cannot create a conflicting second schema.
DO $$
BEGIN
  RAISE NOTICE 'Use backend/schema.sql for a new database or backend/migrations/phase5_enhancements.sql to upgrade an existing database.';
END $$;
