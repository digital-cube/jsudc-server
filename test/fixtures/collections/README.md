The fixture collections the library's tests serve: one per source kind.

- `companies` — postgres_jsonb (no `source.yaml`), 30 rows of the example's companies.
- `notes` — memory, rows from `seed.json`.
- `files` — filesystem over its `tree/`.
- `menu` — yaml_menu over `data/menu.yaml`, listing the other collections live.
- `quakes` — http_api; the tests read the recorded USGS answer in `../http/quakes.json`
  (`UDC_HTTP_FIXTURES`) instead of calling upstream.
