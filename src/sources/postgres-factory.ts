import type { Db } from "../db/client.js";
import type { CollectionAsset } from "../registry.js";
import { makeSource as makeDriverlessSource, type SourceDeps } from "./factory.js";
import { PostgresJsonbSource } from "./postgres-jsonb.js";
import { PostgresTableSource } from "./postgres-table.js";
import type { Source } from "./source.js";

export interface PostgresSourceDeps extends SourceDeps {
  /** Needed by postgres_jsonb and postgres_table collections only. */
  db?: Db | undefined;
}

/**
 * The source `source.yaml` asks for, every kind included: postgres_jsonb and
 * postgres_table here, the rest through the root entry's `makeSource`.
 */
export function makeSource(asset: CollectionAsset, deps: PostgresSourceDeps): Source | null {
  const pageSizeDefault = asset.view.page_size_default;
  const { source } = asset;
  switch (source.kind) {
    case "postgres_jsonb": {
      if (!deps.db) throw new Error(`${asset.name}: a postgres_jsonb collection needs a database`);
      return new PostgresJsonbSource({
        db: deps.db,
        table: source.options.table ?? asset.name,
        initialSchema: asset.schema,
        pageSizeDefault,
      });
    }
    case "postgres_table": {
      if (!deps.db) throw new Error(`${asset.name}: a postgres_table collection needs a database`);
      const o = source.options;
      return new PostgresTableSource({
        db: deps.db,
        schema: asset.schema,
        table: o.table ?? asset.name,
        fields: o.columns,
        idColumn: o.id_column,
        idType: o.id_type,
        versionColumn: o.version_column,
        totalCount: o.total_count,
        pageSizeDefault,
      });
    }
    default:
      return makeDriverlessSource(asset, deps);
  }
}
