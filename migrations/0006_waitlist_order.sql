-- Place in the queue for a squad seat. Set when someone signs up, and again if they rejoin
-- after withdrawing, so rejoining goes to the back of the line. Editing a sign-up keeps it.
ALTER TABLE applications ADD COLUMN queued_at TEXT;
UPDATE applications SET queued_at = created_at WHERE queued_at IS NULL;
