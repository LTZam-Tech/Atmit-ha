-- Rollback of 0007 (development only).
BEGIN;
SET search_path = atimtha, public;
DROP TABLE IF EXISTS notification_delivery;
DROP TABLE IF EXISTS notification_channel;
DROP TYPE IF EXISTS delivery_status;
DROP TYPE IF EXISTS notification_kind;
COMMIT;
