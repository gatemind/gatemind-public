/** A database-independent description of a schema, used by the tenant-rules check. */
export interface ColumnDescription {
  readonly name: string;
  readonly nullable: boolean;
}

export interface IndexDescription {
  readonly name: string;
  readonly primary: boolean;
  readonly unique: boolean;
  /** Columns in index order. */
  readonly columns: readonly string[];
}

export interface ForeignKeyDescription {
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
}

export interface TableDescription {
  readonly name: string;
  readonly columns: readonly ColumnDescription[];
  readonly indexes: readonly IndexDescription[];
  readonly foreignKeys: readonly ForeignKeyDescription[];
}
