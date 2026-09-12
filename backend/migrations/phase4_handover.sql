-- Phase 4: resource handover and recipient confirmation.
ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_status_check;
ALTER TABLE resources ADD CONSTRAINT resources_status_check
  CHECK (status IN ('AVAILABLE', 'REQUESTED', 'ALLOCATED', 'HANDED_OVER', 'COMPLETED'));

ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'HANDED_OVER', 'COMPLETED'));

ALTER TABLE requests ADD COLUMN IF NOT EXISTS handed_over_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;