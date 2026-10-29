-- @jsudc/server: the typed expressions jsonb fields are sorted, compared and indexed by.
-- Postgres refuses `text::date` and `text::timestamptz` in an index expression
-- (both casts are STABLE: they read DateStyle / TimeZone), so the query
-- compiler and the expression indexes both go through these wrappers.
-- `udc_date`: jsudc stores dates as validated ISO `YYYY-MM-DD`, which parses
-- the same under every DateStyle. `udc_timestamptz`: pinned to UTC, so a
-- datetime stored without an offset means UTC wherever it is read.
CREATE OR REPLACE FUNCTION udc_date(text) RETURNS date
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT $1::date $$;

CREATE OR REPLACE FUNCTION udc_timestamptz(text) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET timezone = 'UTC'
  AS $$ SELECT $1::timestamptz $$;
