CREATE TABLE ad_pack_blacklists (
  kind TEXT NOT NULL,
  pack TEXT NOT NULL,
  CONSTRAINT ad_pack_blacklists_kind CHECK (kind IN ('sticker', 'emoji')),
  CONSTRAINT ad_pack_blacklists_pack CHECK (length(pack) BETWEEN 1 AND 64 AND pack NOT GLOB '*[^A-Za-z0-9_]*'),
  PRIMARY KEY (kind, pack)
) STRICT;
--> statement-breakpoint
UPDATE storage_metadata
SET data = jsonb('{"version":14}')
WHERE key = 'schema-version' AND json_extract(data, '$.version') = 13;
