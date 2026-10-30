-- Text field indexes on the code-point collation.
--
-- The query compiler compares and sorts string fields as
-- ((data->>'f') COLLATE "C"), whatever the database's collation, and
-- syncFieldIndexes builds the expression index of an `index: true` text field
-- on that expression. An index made before (on the bare (data->>'f')) no longer
-- matches it, so the planner ignores it: rebuild it on the new expression.
-- Only an index with the name and the exact definition syncFieldIndexes used to
-- give is touched; once rebuilt it no longer matches, so running this again is
-- a no-op. The rebuild locks out writes on that table while it runs.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT i.indexname, i.tablename, m.parts[1] AS field
    FROM pg_indexes AS i
    CROSS JOIN LATERAL regexp_match(
      i.indexdef,
      '^CREATE INDEX \S+ ON \S+ USING btree \(\(\(data ->> ''([a-z][a-z0-9_]*)''::text\)\)\)$'
    ) AS m(parts)
    WHERE i.schemaname = current_schema() AND m.parts IS NOT NULL
  LOOP
    -- indexName(): <table>_data_<field>_idx, or its first 50 characters, a hash and _idx.
    CONTINUE WHEN NOT (
      r.indexname = r.tablename || '_data_' || r.field || '_idx'
      OR (
        length(r.tablename || '_data_' || r.field || '_idx') > 63
        AND left(r.indexname, 50) = left(r.tablename || '_data_' || r.field, 50)
        AND r.indexname ~ '^.{50}_[0-9a-f]{8}_idx$'
      )
    );
    EXECUTE format('DROP INDEX %I', r.indexname);
    EXECUTE format(
      'CREATE INDEX %I ON %I (((data ->> %L) COLLATE "C"))',
      r.indexname,
      r.tablename,
      r.field
    );
  END LOOP;
END
$$;
