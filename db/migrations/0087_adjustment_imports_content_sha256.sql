-- E9: nothing stopped the same adjustment CSV being applied twice, and a
-- second apply posts every ledger row again. (A code comment said re-upload
-- was "blocked by the unique original_filename". 0065 has no such
-- constraint, and a file name would be the wrong key anyway.)
--
-- content_sha256 is the SHA-256 (hex) of the import's normalised rows. It
-- must match contentSha256() in apps/api/src/admin/adjustmentImport.ts:
-- one line per row, "lower(merchant_id),parsed_amount_fils,reason", the
-- lines sorted in byte order and joined with "\n". So line endings,
-- spacing, header case, row order and "4.75" vs "4.750" do not make a
-- second apply look new.
ALTER TABLE adjustment_imports ADD COLUMN content_sha256 TEXT;

-- Backfill past imports from their stored rows, so a sheet applied before
-- this migration is also blocked. If a sheet was already applied more than
-- once, only the earliest import gets the hash (the unique index below
-- would reject the others); the extra imports stay in history, NULL.
WITH hashed AS (
    SELECT r.adjustment_import_id AS id,
           encode(sha256(convert_to(string_agg(
               r.merchant_id::text || ',' || r.parsed_amount_fils::text || ',' || COALESCE(r.reason, ''),
               E'\n' ORDER BY r.merchant_id::text || ',' || r.parsed_amount_fils::text || ',' || COALESCE(r.reason, '') COLLATE "C"
           ), 'UTF8')), 'hex') AS content_sha256
      FROM adjustment_import_rows r
     GROUP BY r.adjustment_import_id
),
ranked AS (
    SELECT h.id, h.content_sha256,
           row_number() OVER (PARTITION BY h.content_sha256 ORDER BY i.created_at, i.id) AS n
      FROM hashed h
      JOIN adjustment_imports i ON i.id = h.id
)
UPDATE adjustment_imports a
   SET content_sha256 = ranked.content_sha256
  FROM ranked
 WHERE ranked.id = a.id AND ranked.n = 1;

CREATE UNIQUE INDEX uq_adjustment_imports_content_sha256
    ON adjustment_imports (content_sha256)
    WHERE content_sha256 IS NOT NULL;
