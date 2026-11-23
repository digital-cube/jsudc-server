// Full-text search on a `sqlite_table` collection with SQLite's FTS5: the
// search box's text turned into a MATCH expression FTS5 always accepts, the
// SQL of an external-content FTS5 table kept in step by triggers in the
// database, and the `search` option of `SqliteTableSource` over that table.

import { type SQL, sql } from "drizzle-orm";
import { columnName, identifier, type SqliteTableSearch } from "./sqlite-table.js";

/** A term worth searching: at least one letter or digit (what `unicode61` makes tokens of). */
const HAS_TOKEN = /[\p{L}\p{N}]/u;

export interface Fts5MatchOptions {
  /**
   * The last term matches as a prefix (`"inv"*` finds `invoice`): the search
   * box answers while the word is still being typed. Default `true`.
   */
  prefix?: boolean | undefined;
  /** At most this many terms; the rest of the text is ignored. Default 32. */
  maxTerms?: number | undefined;
}

/**
 * The search box's text as an FTS5 `MATCH` expression that never raises a
 * syntax error: the text is split on whitespace, every term is quoted as an
 * FTS5 string (`"` doubled inside), the terms are ANDed, and the last one may
 * match as a prefix. A term with no letter or digit (`-`, `*`, `"`, `:`) is
 * dropped, so operators and column filters typed into the box are words, not
 * syntax: `a OR` is `"a" AND "OR"*`, `title:x` is the phrase `"title:x"`.
 * `null` when no term is left (an empty or punctuation-only text): the
 * caller matches nothing then (`sqliteFts5Search` puts `0` in place of the
 * condition) instead of handing FTS5 an expression it would refuse.
 */
export function fts5MatchExpression(text: string, opts: Fts5MatchOptions = {}): string | null {
  const max = opts.maxTerms ?? 32;
  const terms = text
    .split(/\s+/u)
    .filter((t) => HAS_TOKEN.test(t))
    .slice(0, max)
    .map((t) => `"${t.replaceAll('"', '""')}"`);
  if (terms.length === 0) return null;
  if (opts.prefix ?? true) terms[terms.length - 1] += "*";
  return terms.join(" AND ");
}

export interface SqliteFts5Options {
  /** The collection's table, the FTS5 table's content (`note`). */
  table: string;
  /** The FTS5 table (default `<table>_fts`). */
  fts?: string | undefined;
  /** The columns of `table` indexed, in order (`["title", "body_text"]`). */
  columns: readonly string[];
}

export interface SqliteFts5SqlOptions extends SqliteFts5Options {
  /**
   * The FTS5 `tokenize` option, as written in `CREATE VIRTUAL TABLE`.
   * Default `unicode61` (case-folded Unicode words, diacritics removed from
   * Latin letters); `unicode61 remove_diacritics 2` folds more of them,
   * `porter unicode61` adds English stemming.
   */
  tokenize?: string | undefined;
  /** The triggers' name prefix (default the FTS5 table's name). */
  triggerPrefix?: string | undefined;
}

/** Only letters, digits, spaces and the characters a tokenizer argument needs. */
const TOKENIZE = /^[A-Za-z0-9_ .'"-]+$/;

function names(opts: SqliteFts5Options): { table: string; fts: string; columns: string[] } {
  const table = columnName(opts.table, "table");
  const fts = columnName(opts.fts ?? `${table}_fts`, "FTS5 table");
  if (opts.columns.length === 0) throw new Error("sqliteFts5Sql: columns is empty");
  const columns = opts.columns.map((c) => columnName(c, "FTS5 column"));
  return { table, fts, columns };
}

const q = (name: string): string => `"${name}"`;

/**
 * The SQL of an external-content FTS5 table over `table` and the triggers
 * that keep it in step, run once (a migration): `CREATE VIRTUAL TABLE … USING
 * fts5(…, content='<table>', content_rowid='rowid')`, an insert, a delete and
 * an update trigger (the update one only when an indexed column is set), and
 * a `rebuild` that indexes the rows already there. The triggers live in the
 * database, so a row written by any process — another server, a customer's
 * tool, the `sqlite3` shell — is indexed in the same transaction; the source
 * maintains nothing. Every statement is `IF NOT EXISTS`; the rebuild is
 * idempotent. Needs a rowid table (not `WITHOUT ROWID`). Names are bare
 * (no `schema.`): run it on the database the table is in.
 *
 * A table without an `INTEGER PRIMARY KEY` (a uuid id) has rowids `VACUUM`
 * may renumber: run `sqliteFts5RebuildSql` after a `VACUUM` of such a file.
 */
export function sqliteFts5Sql(opts: SqliteFts5SqlOptions): string {
  const { table, fts, columns } = names(opts);
  const tokenize = opts.tokenize ?? "unicode61";
  if (!TOKENIZE.test(tokenize)) throw new Error(`invalid tokenize ${JSON.stringify(tokenize)}`);
  const prefix = columnName(opts.triggerPrefix ?? fts, "trigger prefix");
  const cols = columns.map(q).join(", ");
  const newVals = columns.map((c) => `new.${q(c)}`).join(", ");
  const oldVals = columns.map((c) => `old.${q(c)}`).join(", ");
  const remove = `INSERT INTO ${q(fts)}(${q(fts)}, rowid, ${cols}) VALUES ('delete', old.rowid, ${oldVals});`;
  const add = `INSERT INTO ${q(fts)}(rowid, ${cols}) VALUES (new.rowid, ${newVals});`;
  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${q(fts)} USING fts5(${cols}, content='${table}', content_rowid='rowid', tokenize='${tokenize.replaceAll("'", "''")}');`,
    `CREATE TRIGGER IF NOT EXISTS ${q(`${prefix}_ai`)} AFTER INSERT ON ${q(table)} BEGIN`,
    `  ${add}`,
    "END;",
    `CREATE TRIGGER IF NOT EXISTS ${q(`${prefix}_ad`)} AFTER DELETE ON ${q(table)} BEGIN`,
    `  ${remove}`,
    "END;",
    `CREATE TRIGGER IF NOT EXISTS ${q(`${prefix}_au`)} AFTER UPDATE OF ${cols} ON ${q(table)} BEGIN`,
    `  ${remove}`,
    `  ${add}`,
    "END;",
    sqliteFts5RebuildSql(opts),
  ].join("\n");
}

/** `INSERT INTO <fts>(<fts>) VALUES ('rebuild');`: the index made again from the content table. */
export function sqliteFts5RebuildSql(opts: SqliteFts5Options): string {
  const { fts } = names(opts);
  return `INSERT INTO ${q(fts)}(${q(fts)}) VALUES ('rebuild');`;
}

export interface SqliteFts5SearchOptions extends Fts5MatchOptions {
  /** The collection's table (`note`, or `aux.note`): the source's `table`. */
  table: string;
  /** The FTS5 table (default `<table>_fts`, in the same database). */
  fts?: string | undefined;
  /**
   * The weight of each indexed column in `bm25()`, in the FTS5 table's column
   * order (`[10, 1]`: a hit in the title counts ten times one in the body).
   * Default: every column 1.
   */
  weights?: readonly number[] | undefined;
}

/**
 * The `search` option of `SqliteTableSource` over an FTS5 table (made by
 * `sqliteFts5Sql`): the text becomes `fts5MatchExpression(text)`, bound as a
 * parameter; `match` is `<table>.rowid IN (SELECT rowid FROM <fts> WHERE <fts>
 * MATCH ?)` and `rank` is `-bm25(<fts>)` of the row (bm25 is lower for a
 * better hit), so a search without a `sort` comes best first. A text that
 * leaves no term matches nothing.
 */
export function sqliteFts5Search(opts: SqliteFts5SearchOptions): SqliteTableSearch {
  const table = identifier(opts.table, "table");
  const parts = opts.table.split(".");
  const bare = parts.at(-1) as string;
  const schema = parts.length === 2 ? `${parts[0]}.` : "";
  const ftsName = opts.fts ?? `${schema}${bare}_fts`;
  const fts = identifier(ftsName, "FTS5 table");
  // MATCH and bm25() take the FTS5 table's own name, unqualified.
  const self = sql.identifier(ftsName.split(".").at(-1) as string);
  const weights = (opts.weights ?? []).map((w) => {
    if (!Number.isFinite(w)) throw new Error(`invalid bm25 weight ${w}`);
    return sql.raw(String(w));
  });
  const bm25 = weights.length
    ? sql`bm25(${self}, ${sql.join(weights, sql`, `)})`
    : sql`bm25(${self})`;
  const expr = (text: string): string | null => fts5MatchExpression(text, opts);
  return {
    match: (_q, text): SQL => {
      const e = expr(text);
      if (e === null) return sql`0`;
      return sql`${table}.rowid IN (SELECT rowid FROM ${fts} WHERE ${self} MATCH ${e})`;
    },
    rank: (_q, text): SQL => {
      const e = expr(text);
      if (e === null) return sql`NULL`;
      return sql`(SELECT -${bm25} FROM ${fts} WHERE ${self} MATCH ${e} AND rowid = ${table}.rowid)`;
    },
  };
}
