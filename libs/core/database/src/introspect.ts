import type { Connection, RowDataPacket } from 'mysql2/promise';
import type {
  ForeignKeyDescription,
  IndexDescription,
  TableDescription,
} from './schema-description';

interface ColumnRow extends RowDataPacket {
  table_name: string;
  column_name: string;
  is_nullable: string;
}
interface IndexRow extends RowDataPacket {
  table_name: string;
  index_name: string;
  non_unique: number;
  column_name: string | null;
}
interface ForeignKeyRow extends RowDataPacket {
  table_name: string;
  constraint_name: string;
  column_name: string;
  referenced_table_name: string;
  referenced_column_name: string;
}

/**
 * Reads the real tables of a MySQL database from `information_schema`, so the tenant-rules check
 * looks at what actually ships and not at what the ORM schema claims.
 */
export async function describeMysqlSchema(
  connection: Connection,
  schema: string,
): Promise<TableDescription[]> {
  const [columns] = await connection.query<ColumnRow[]>(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, IS_NULLABLE AS is_nullable
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  );
  const [indexes] = await connection.query<IndexRow[]>(
    `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique,
            COLUMN_NAME AS column_name
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema],
  );
  const [foreignKeys] = await connection.query<ForeignKeyRow[]>(
    `SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS constraint_name, COLUMN_NAME AS column_name,
            REFERENCED_TABLE_NAME AS referenced_table_name,
            REFERENCED_COLUMN_NAME AS referenced_column_name
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    [schema],
  );

  const tables = new Map<
    string,
    {
      columns: { name: string; nullable: boolean }[];
      indexes: Map<string, { primary: boolean; unique: boolean; columns: string[] }>;
      foreignKeys: Map<string, { columns: string[]; table: string; referenced: string[] }>;
    }
  >();
  const tableOf = (name: string) => {
    let entry = tables.get(name);
    if (entry === undefined) {
      entry = { columns: [], indexes: new Map(), foreignKeys: new Map() };
      tables.set(name, entry);
    }
    return entry;
  };

  for (const row of columns) {
    tableOf(row.table_name).columns.push({
      name: row.column_name,
      nullable: row.is_nullable === 'YES',
    });
  }
  for (const row of indexes) {
    const indexMap = tableOf(row.table_name).indexes;
    const index = indexMap.get(row.index_name) ?? {
      primary: row.index_name === 'PRIMARY',
      unique: row.non_unique === 0,
      columns: [],
    };
    index.columns.push(row.column_name ?? '(expression)');
    indexMap.set(row.index_name, index);
  }
  for (const row of foreignKeys) {
    const fkMap = tableOf(row.table_name).foreignKeys;
    const fk = fkMap.get(row.constraint_name) ?? {
      columns: [],
      table: row.referenced_table_name,
      referenced: [],
    };
    fk.columns.push(row.column_name);
    fk.referenced.push(row.referenced_column_name);
    fkMap.set(row.constraint_name, fk);
  }

  return [...tables.entries()].map(([name, entry]) => ({
    name,
    columns: entry.columns,
    indexes: [...entry.indexes.entries()].map(([indexName, i]): IndexDescription => ({
      name: indexName,
      ...i,
    })),
    foreignKeys: [...entry.foreignKeys.entries()].map(([fkName, fk]): ForeignKeyDescription => ({
      name: fkName,
      columns: fk.columns,
      referencedTable: fk.table,
      referencedColumns: fk.referenced,
    })),
  }));
}
