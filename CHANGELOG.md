# Changelog

All notable changes to `@jsudc/server` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). `@jsudc/core`,
`@jsudc/server` and `@jsudc/react` share one version line and release together.

## [Unreleased]

## [0.2.1] - 2026-10-30

Released in lockstep with `@jsudc/react` 0.2.1; `@jsudc/core` stays 0.2.0 and
the peer range `^0.2.0` is unchanged.

### Fixed

- String comparisons and sorts no longer depend on the database's collation.
  `gt`, `gte`, `lt`, `lte` and `between` on a text field, `ORDER BY` and the
  cursor of `list` compare by code point (`COLLATE "C"`), as `evaluateFilter`
  in `@jsudc/core` does. On a database with a linguistic collation (the
  `postgres` image's default `en_US.utf8`) the same filter used to give the
  server one result and the browser another: `gt "a"` matched `Alfa`, and
  sorting put `beta` before `Gama`. `case_insensitive` comparisons lower-case
  under the database's collation, then compare by code point.
- The expression index of an `index: true` text field is built on the same
  `COLLATE "C"` expression, so the planner keeps using it. The new migration
  `0002_udc_text_index_collation.sql` (run by `ensureUdcSchema`) rebuilds an
  index made before on the bare expression; that locks writes on the table
  while it runs, once.

### Changed

- CI tests against `postgres:16` with its default locale (`en_US.utf8`) and
  with `C.UTF-8`; the publish workflow uses the default locale. The
  `--locale=C.UTF-8` workaround of 0.2.0 is gone.

## [0.2.0] - 2026-10-30

No changes to the code or the API; released in lockstep with `@jsudc/react`
0.2.0, whose breaking changes move the shared version line to 0.2.

### Changed

- The `@jsudc/core` peer range is `^0.2.0`. Install `@jsudc/core@0.2.0`
  next to this package (its code is that of 0.1.1).
- Development installs `@jsudc/core` from npm (`^0.1.1`) instead of
  `github:digital-cube/jsudc-core#v0.1.0`; `package-lock.json` no longer pins
  it over SSH, and CI and the publish workflow drop the deploy-key step.
- CI and the publish workflow initialise their Postgres with
  `--locale=C.UTF-8`, the byte-order collation of development: under the
  image's default `en_US.utf8` the string comparisons of `pg-filter.test.ts`
  (`gt`, `gte`, `lte`, `between`) disagree with the in-memory evaluator, so CI
  was red and a tag could not publish. The library's SQL is unchanged.

## [0.1.1] - 2026-10-29

First release on npmjs.org. No change to the code or the API.

### Added

- Published to npmjs.org as a public package; `npm install @jsudc/server`.
- Tags `v*` publish themselves from GitHub Actions with npm provenance
  (`.github/workflows/publish.yml`, OIDC trusted publishing, no token).
- `CHANGELOG.md`; a committed `package-lock.json`, so CI and the publish
  workflow run `npm ci`.

### Changed

- `@jsudc/core` is a **peer dependency**, `^0.1.1` from npm, instead of a
  dependency on `github:digital-cube/jsudc-core#v0.1.0`: install it next to
  this package, so the application has one copy of the protocol.
- `package.json`: `publishConfig.access: "public"`, `repository` / `bugs` in
  object form, keywords `universal-data-collections` and `data-grid`.
- README: install from npm; the GitHub tag stays as an alternative.

## [0.1.0] - 2026-10-29

First tagged version, installed from the GitHub tag.

### Added

- A UDC server in TypeScript: the dispatcher, the collection registry, five
  sources (Postgres jsonb, memory, filesystem, HTTP API, YAML menu), schema
  revisions and edits, seeding, and `udcPlugin`, a Fastify plugin with the
  OpenAPI document of every action.
- `migrations/`: the UDC-owned SQL (`udc_schema_revisions`, the `udc_date` /
  `udc_timestamptz` casts), also run by `ensureUdcSchema`.

[Unreleased]: https://github.com/digital-cube/jsudc-server/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/digital-cube/jsudc-server/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/digital-cube/jsudc-server/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/digital-cube/jsudc-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/digital-cube/jsudc-server/releases/tag/v0.1.0
