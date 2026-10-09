type CatalogClient = {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>
  exec(sql: string): Promise<unknown>
}

const identifier = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`
const literal = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`

/** Test-only logical schema reconstruction in a disposable in-memory PGlite DB.
 * Uses observed PostgreSQL deparsers, not the bundled expected schema. This is
 * NOT pg_dump/pg_restore, does not copy data/ACLs and never targets a server. */
export async function recreateNativeCatalog(db: CatalogClient): Promise<void> {
  const enums = (await db.query(`SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) labels
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname='public' GROUP BY t.typname ORDER BY t.typname`)).rows
  const columns = (await db.query(`SELECT c.relname, a.attname, a.attnum,
    format_type(a.atttypid,a.atttypmod) type, a.attnotnull, pg_get_expr(d.adbin,d.adrelid) definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`)).rows
  const sequences = (await db.query(`SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size
    FROM pg_sequences WHERE schemaname='public'`)).rows
  const constraints = (await db.query(`SELECT c.relname, con.conname, pg_get_constraintdef(con.oid,false) definition
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY CASE con.contype WHEN 'f' THEN 1 ELSE 0 END,c.relname,con.conname`)).rows
  const indexes = (await db.query(`SELECT pg_get_indexdef(i.indexrelid) definition FROM pg_index i
    JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_constraint x
      WHERE x.conindid=i.indexrelid AND x.contype IN ('p','u','x')) ORDER BY i.indexrelid`)).rows

  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  for (const item of enums) {
    if (!Array.isArray(item.labels)) throw new Error('invalid_fixture_enum_labels')
    await db.exec(`CREATE TYPE public.${identifier(item.typname)} AS ENUM (${item.labels.map(literal).join(',')})`)
  }
  for (const item of sequences) await db.exec(`CREATE SEQUENCE public.${identifier(item.sequencename)}
    START ${item.start_value} MINVALUE ${item.min_value} MAXVALUE ${item.max_value}
    INCREMENT ${item.increment_by} CACHE ${item.cache_size} ${item.cycle ? 'CYCLE' : 'NO CYCLE'}`)
  for (const table of new Set(columns.map(column => column.relname))) {
    const definitions = columns.filter(column => column.relname === table).map(column =>
      `${identifier(column.attname)} ${column.type}${column.definition === null ? '' : ` DEFAULT ${column.definition}`}${column.attnotnull ? ' NOT NULL' : ''}`)
    await db.exec(`CREATE TABLE public.${identifier(table)} (${definitions.join(',')})`)
  }
  for (const item of constraints) await db.exec(`ALTER TABLE public.${identifier(item.relname)}
    ADD CONSTRAINT ${identifier(item.conname)} ${item.definition}`)
  for (const item of indexes) await db.exec(String(item.definition))
}
