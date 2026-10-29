-- Deleting a webhook endpoint that had any deliveries failed with a foreign-key
-- error (a 500 to the merchant). The intent (webhooks/cancel.ts) is that the
-- delivery log and archives are kept as an audit trail, with endpoint_id set
-- to NULL. The comments claiming "ON DELETE SET NULL (0029)" and "ON DELETE
-- CASCADE (0047)" were never true; this migration does what they describe.

ALTER TABLE webhook_deliveries ALTER COLUMN endpoint_id DROP NOT NULL;
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_endpoint_id_fkey;
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_endpoint_id_fkey
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id) ON DELETE SET NULL;

ALTER TABLE webhook_delivery_archives ALTER COLUMN endpoint_id DROP NOT NULL;
ALTER TABLE webhook_delivery_archives DROP CONSTRAINT webhook_delivery_archives_endpoint_id_fkey;
ALTER TABLE webhook_delivery_archives
  ADD CONSTRAINT webhook_delivery_archives_endpoint_id_fkey
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id) ON DELETE SET NULL;
