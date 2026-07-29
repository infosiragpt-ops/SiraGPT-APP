-- A pairing must belong to the same company as its business channel. Abort
-- before changing constraints if historical data violates that invariant.
BEGIN;

-- Hold writes until the composite foreign key is installed so the preflight
-- check and the DDL operate on the same data snapshot.
LOCK TABLE "business_channels", "business_channel_pairings"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  inconsistent_pairings BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO inconsistent_pairings
    FROM "business_channel_pairings" AS pairing
    JOIN "business_channels" AS channel
      ON channel."id" = pairing."channelId"
   WHERE pairing."companyId" IS DISTINCT FROM channel."companyId";

  IF inconsistent_pairings > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce pairing/channel company integrity: % inconsistent business_channel_pairings row(s) exist',
      inconsistent_pairings
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE UNIQUE INDEX "business_channels_id_companyId_key"
  ON "business_channels"("id", "companyId");

ALTER TABLE "business_channel_pairings"
  DROP CONSTRAINT "business_channel_pairings_channelId_fkey";

ALTER TABLE "business_channel_pairings"
  ADD CONSTRAINT "business_channel_pairings_channelId_companyId_fkey"
  FOREIGN KEY ("channelId", "companyId")
  REFERENCES "business_channels"("id", "companyId")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

COMMIT;
