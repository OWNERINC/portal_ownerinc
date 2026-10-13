import { createHash } from 'node:crypto';

export const LOGICAL_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
export const LOGICAL_SNAPSHOT_MAX_ROWS = 100_000;
export const logicalSnapshotErrorCodes = Object.freeze([
  'logical_snapshot_unsafe_number', 'logical_snapshot_check_parser_missing',
  'logical_snapshot_invalid_identity', 'logical_snapshot_limit_exceeded',
  'logical_snapshot_invalid_encoding', 'logical_snapshot_invalid_transport',
  'logical_snapshot_incomplete', 'logical_snapshot_invalid_schema', 'logical_snapshot_invalid_check',
  'logical_snapshot_invalid_table', 'logical_snapshot_invalid_row', 'logical_snapshot_invalid_sequence',
  'logical_snapshot_invalid_record', 'logical_snapshot_incomplete_schema', 'logical_snapshot_unsupported_object',
  'logical_snapshot_incomplete_data_inventory', 'logical_snapshot_incomplete_sequence_inventory',
  'logical_snapshot_row_count_mismatch', 'logical_snapshot_failed',
]);
const namespace = alias => `${alias}.nspname NOT IN ('pg_catalog','information_schema')
  AND ${alias}.nspname !~ '^pg_toast(_temp_[0-9]+)?$' AND ${alias}.nspname !~ '^pg_temp_[0-9]+$'`;
const typeIdentity = oid => `(SELECT jsonb_build_array(ns.nspname,t.typname) FROM pg_type t JOIN pg_namespace ns ON ns.oid=t.typnamespace WHERE t.oid=${oid})`;
const collationIdentity = oid => `(SELECT jsonb_build_array(ns.nspname,c.collname) FROM pg_collation c JOIN pg_namespace ns ON ns.oid=c.collnamespace WHERE c.oid=${oid})`;
const section = (name, query) => `SELECT jsonb_build_object('kind','schema','section','${name}',
  'items',COALESCE(jsonb_agg(to_jsonb(item)),'[]'::jsonb))::text AS record FROM (${query}) item`;

// Independent fixture inventory. No controller fingerprint, expected schema,
// migration allowlist or row exclusions. Physical OIDs are resolved to names;
// visible-column ordinal is dense so dropped attnum holes are not identities.
export const schemaSnapshotQueries = Object.freeze({
  database: `SELECT pg_encoding_to_char(encoding) AS encoding, datcollate, datctype,
    datlocprovider, daticulocale, datcollversion,to_jsonb(db)->>'daticurules' AS icu_rules
    FROM pg_database db WHERE datname=current_database()`,
  namespaces: `SELECT nspname AS name, obj_description(oid,'pg_namespace') AS comment FROM pg_namespace n WHERE ${namespace('n')}`,
  extensions: `SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema,e.extrelocatable,
    (SELECT jsonb_agg(jsonb_build_array(ns.nspname,c.relname,x.condition) ORDER BY ns.nspname,c.relname)
      FROM unnest(e.extconfig,e.extcondition) x(id,condition) JOIN pg_class c ON c.oid=x.id
      JOIN pg_namespace ns ON ns.oid=c.relnamespace) AS configuration
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace`,
  relations: `SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.relpersistence,
    c.relreplident,c.relrowsecurity,c.relforcerowsecurity,c.relispartition,c.relispopulated,
    am.amname AS method,ts.spcname AS tablespace,
    ARRAY(SELECT unnest(c.reloptions) ORDER BY 1) AS options,
    CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,false) END AS view,
    CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound,c.oid,false) END AS partition_bound,
    CASE WHEN c.relkind='p' THEN pg_get_partkeydef(c.oid) END AS partition_key,
    obj_description(c.oid,'pg_class') AS comment
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_am am ON am.oid=c.relam LEFT JOIN pg_tablespace ts ON ts.oid=c.reltablespace
    WHERE ${namespace('n')}`,
  columns: `SELECT n.nspname AS schema,c.relname AS relation,a.attname AS name,
    (row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum))::text AS ordinal,
    ${typeIdentity('a.atttypid')} AS type,format_type(a.atttypid,a.atttypmod) AS formatted_type,
    a.attndims,a.attnotnull,a.attidentity,a.attgenerated,a.attstorage,a.attcompression,a.attstattarget,
    a.attislocal,a.attinhcount,${collationIdentity('a.attcollation')} AS collation,
    ARRAY(SELECT unnest(a.attoptions) ORDER BY 1) AS options,
    pg_get_expr(d.adbin,d.adrelid,false) AS default_expression,col_description(c.oid,a.attnum) AS comment
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE ${namespace('n')} AND c.relkind NOT IN ('i','I','S')`,
  types: `SELECT n.nspname AS schema,t.typname AS name,t.typtype AS kind,t.typcategory,
    t.typlen,t.typbyval,t.typalign,t.typstorage,t.typdelim,t.typnotnull,t.typndims,t.typtypmod,t.typisdefined,
    ${typeIdentity('t.typelem')} AS element,${typeIdentity('t.typbasetype')} AS base,
    ${typeIdentity('t.typarray')} AS array,
    (SELECT jsonb_agg(jsonb_build_array(f.kind,pn.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) ORDER BY f.kind)
      FROM (VALUES ('input',t.typinput),('output',t.typoutput),('receive',t.typreceive),('send',t.typsend),
        ('mod_in',t.typmodin),('mod_out',t.typmodout),('analyze',t.typanalyze),('subscript',t.typsubscript)) f(kind,id)
      JOIN pg_proc p ON p.oid=f.id JOIN pg_namespace pn ON pn.oid=p.pronamespace) AS functions,
    ${collationIdentity('t.typcollation')} AS collation,t.typdefault,
    pg_get_expr(t.typdefaultbin,0,false) AS default_expression,
    (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid) AS labels,
    (SELECT jsonb_build_array(ns.nspname,c.relname) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE c.oid=t.typrelid) AS relation,
    obj_description(t.oid,'pg_type') AS comment
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${namespace('n')}`,
  indexes: `SELECT n.nspname AS schema,c.relname AS name,tn.nspname AS table_schema,tc.relname AS relation,
    i.indisunique,i.indnullsnotdistinct,i.indisprimary,i.indisexclusion,i.indimmediate,i.indisclustered,
    i.indisvalid,i.indisready,i.indislive,i.indisreplident,i.indnkeyatts,i.indnatts,
    pg_get_indexdef(c.oid) AS definition,
    pg_get_expr(i.indpred,i.indrelid,false) AS predicate,pg_get_expr(i.indexprs,i.indrelid,false) AS expressions
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class tc ON tc.oid=i.indrelid JOIN pg_namespace tn ON tn.oid=tc.relnamespace WHERE ${namespace('n')}`,
  constraints: `SELECT n.nspname AS schema,c.relname AS relation,t.typname AS domain,
    x.conname AS name,x.contype AS kind,x.condeferrable,x.condeferred,x.convalidated,
    x.conislocal,x.coninhcount,x.connoinherit,pg_get_constraintdef(x.oid,false) AS definition,
    (SELECT jsonb_build_array(pn.nspname,pc.relname,p.conname) FROM pg_constraint p
      LEFT JOIN pg_class pc ON pc.oid=p.conrelid JOIN pg_namespace pn ON pn.oid=p.connamespace WHERE p.oid=x.conparentid) AS parent,
    obj_description(x.oid,'pg_constraint') AS comment
    FROM pg_constraint x JOIN pg_namespace n ON n.oid=x.connamespace
    LEFT JOIN pg_class c ON c.oid=x.conrelid LEFT JOIN pg_type t ON t.oid=x.contypid WHERE ${namespace('n')}`,
  routines: `SELECT n.nspname AS schema,p.proname AS name,p.prokind AS kind,
    pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_function_result(p.oid) AS result,
    pg_get_functiondef(p.oid) AS definition,p.provolatile,p.proparallel,p.proisstrict,p.prosecdef,p.proleakproof,
    p.proretset,p.procost::text,p.prorows::text,
    ARRAY(SELECT unnest(p.proconfig) ORDER BY 1) AS configuration,obj_description(p.oid,'pg_proc') AS comment
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${namespace('n')} AND p.prokind<>'a'`,
  triggers: `SELECT n.nspname AS schema,c.relname AS relation,t.tgname AS name,t.tgenabled,
    pg_get_triggerdef(t.oid,false) AS definition,obj_description(t.oid,'pg_trigger') AS comment
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE ${namespace('n')} AND NOT t.tgisinternal`,
  rules: `SELECT n.nspname AS schema,c.relname AS relation,r.rulename AS name,r.ev_enabled,
    pg_get_ruledef(r.oid,false) AS definition FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace('n')}`,
  policies: `SELECT n.nspname AS schema,c.relname AS relation,p.polname AS name,p.polcmd,p.polpermissive,
    ARRAY(SELECT CASE WHEN id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(id)::text END FROM unnest(p.polroles) id ORDER BY 1) AS roles,
    pg_get_expr(p.polqual,p.polrelid,false) AS qualifier,pg_get_expr(p.polwithcheck,p.polrelid,false) AS with_check
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace('n')}`,
  inheritance: `SELECT n.nspname AS schema,c.relname AS relation,pn.nspname AS parent_schema,p.relname AS parent,
    i.inhseqno,i.inhdetachpending FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class p ON p.oid=i.inhparent
    JOIN pg_namespace pn ON pn.oid=p.relnamespace WHERE ${namespace('n')}`,
  sequences: `SELECT n.nspname AS schema,c.relname AS name,${typeIdentity('s.seqtypid')} AS type,
    s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle,
    (SELECT jsonb_build_array(tn.nspname,t.relname,a.attname,d.deptype) FROM pg_depend d
      JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')) AS owned_by
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace('n')}`,
  collations: `SELECT n.nspname AS schema,c.collname AS name,c.collprovider,c.collisdeterministic,c.collencoding,
    c.collcollate,c.collctype,c.colliculocale,c.collversion,to_jsonb(c)->>'collicurules' AS icu_rules
    FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE ${namespace('n')}`,
  statistics: `SELECT n.nspname AS schema,s.stxname AS name,s.stxstattarget,pg_get_statisticsobjdef(s.oid) AS definition
    FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid=s.stxnamespace WHERE ${namespace('n')}`,
  security_labels: `SELECT label.provider,label.label,object.type,object.schema,object.name,object.identity
    FROM pg_seclabel label CROSS JOIN LATERAL pg_identify_object(label.classoid,label.objoid,label.objsubid) object
    WHERE object.schema IS NULL OR (object.schema NOT IN ('pg_catalog','information_schema')
      AND object.schema !~ '^pg_toast(_temp_[0-9]+)?$' AND object.schema !~ '^pg_temp_[0-9]+$')`,
  casts: `SELECT ${typeIdentity('x.castsource')} AS source,${typeIdentity('x.casttarget')} AS target,
    x.castcontext,x.castmethod,
    (SELECT jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=x.castfunc) AS function
    FROM pg_cast x`,
  unsupported: `SELECT 'relation' AS kind,n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE ${namespace('n')} AND c.relkind NOT IN ('r','p','i','I','S','v','m','c')
    UNION ALL SELECT 'type',n.nspname,t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE ${namespace('n')} AND t.typtype NOT IN ('e','d','c') AND NOT (t.typtype='b' AND t.typelem<>0 AND t.typcategory='A')
    UNION ALL SELECT 'aggregate',n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${namespace('n')} AND p.prokind='a'
    UNION ALL SELECT 'operator',n.nspname,o.oprname FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE ${namespace('n')}
    UNION ALL SELECT 'operator_class',n.nspname,o.opcname FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace WHERE ${namespace('n')}
    UNION ALL SELECT 'operator_family',n.nspname,o.opfname FROM pg_opfamily o JOIN pg_namespace n ON n.oid=o.opfnamespace WHERE ${namespace('n')}
    UNION ALL SELECT 'text_search_config',n.nspname,o.cfgname FROM pg_ts_config o JOIN pg_namespace n ON n.oid=o.cfgnamespace WHERE ${namespace('n')}
    UNION ALL SELECT 'text_search_dictionary',n.nspname,o.dictname FROM pg_ts_dict o JOIN pg_namespace n ON n.oid=o.dictnamespace WHERE ${namespace('n')}
    UNION ALL SELECT 'text_search_parser',n.nspname,o.prsname FROM pg_ts_parser o JOIN pg_namespace n ON n.oid=o.prsnamespace WHERE ${namespace('n')}
    UNION ALL SELECT 'text_search_template',n.nspname,o.tmplname FROM pg_ts_template o JOIN pg_namespace n ON n.oid=o.tmplnamespace WHERE ${namespace('n')}
    UNION ALL SELECT 'publication','',pubname FROM pg_publication
    UNION ALL SELECT 'subscription','',subname FROM pg_subscription
    UNION ALL SELECT 'event_trigger','',evtname FROM pg_event_trigger
    UNION ALL SELECT 'foreign_server','',srvname FROM pg_foreign_server
    UNION ALL SELECT 'foreign_data_wrapper','',fdwname FROM pg_foreign_data_wrapper
    UNION ALL SELECT 'conversion',n.nspname,c.conname FROM pg_conversion c
      JOIN pg_namespace n ON n.oid=c.connamespace WHERE ${namespace('n')}
    -- PostgreSQL's seven bootstrap AM identities, not just their names. A user
    -- AM (including an unused/handlerless one) cannot masquerade by spelling.
    UNION ALL SELECT 'access_method','',amname FROM pg_am
      WHERE NOT ((oid,amname,amtype,amhandler) IN (
        (2::oid,'heap','t','pg_catalog.heap_tableam_handler'::regproc),
        (403::oid,'btree','i','pg_catalog.bthandler'::regproc),
        (405::oid,'hash','i','pg_catalog.hashhandler'::regproc),
        (783::oid,'gist','i','pg_catalog.gisthandler'::regproc),
        (2742::oid,'gin','i','pg_catalog.ginhandler'::regproc),
        (4000::oid,'spgist','i','pg_catalog.spghandler'::regproc),
        (3580::oid,'brin','i','pg_catalog.brinhandler'::regproc)))
    UNION ALL SELECT 'large_object','',oid::text FROM pg_largeobject_metadata
    UNION ALL SELECT 'transform',n.nspname,t.typname FROM pg_transform x JOIN pg_type t ON t.oid=x.trftype JOIN pg_namespace n ON n.oid=t.typnamespace
    UNION ALL SELECT 'language','',lanname FROM pg_language WHERE lanname NOT IN ('internal','c','sql','plpgsql')`,
});

// PG emits a JSONB map of column -> typed SQL text (or SQL NULL), itself carried
// as a JSON string. Unlike to_jsonb(row), this distinguishes SQL NULL from JSON
// null and retains JSON lexemes, array bounds, composite nulls and int64 values.
// Types are independently bound by schema. No JS numeric conversion of data.
// ONLY avoids duplicate inherited rows; sequence reads never call nextval.
export const dataStatementsSQL = `WITH tables AS (
  SELECT n.nspname,c.relname,COALESCE((SELECT format(
    '(SELECT jsonb_object_agg(k,v)::text FROM (VALUES %s) AS fixture_row(k,v))',
    string_agg(format('(%L,t.%I::text)',a.attname,a.attname),',' ORDER BY a.attnum))
    FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped HAVING count(*)>0),
    '''{}''::jsonb::text') AS row_expression
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace('n')} AND c.relkind IN ('r','p','m'))
  SELECT format(
  'SELECT jsonb_build_object(''kind'',''table'',''schema'',%L,''name'',%L,''count'',count(*)::text)::text AS record FROM ONLY %I.%I; SELECT jsonb_build_object(''kind'',''row'',''schema'',%L,''name'',%L,''text'',row_text)::text AS record FROM (SELECT %s AS row_text FROM ONLY %I.%I t) fixture_rows ORDER BY row_text COLLATE "C";',
  nspname,relname,nspname,relname,nspname,relname,row_expression,nspname,relname) AS statement FROM tables
  UNION ALL SELECT format('SELECT jsonb_build_object(''kind'',''sequence'',''schema'',%L,''name'',%L,''last_value'',last_value::text,''is_called'',is_called)::text AS record FROM %I.%I;',
    n.nspname,c.relname,n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE ${namespace('n')} AND c.relkind='S'`;

export const logicalSnapshotSettings = `SET LOCAL search_path=pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL client_encoding='UTF8';
SET LOCAL lc_numeric='C'; SET LOCAL lc_monetary='C'; SET LOCAL lc_time='C';
SET LOCAL datestyle='ISO, YMD'; SET LOCAL intervalstyle='postgres'; SET LOCAL extra_float_digits=3;
SET LOCAL bytea_output='hex'; SET LOCAL statement_timeout='120s';`;
export const logicalSnapshotScript = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
${logicalSnapshotSettings}
${Object.entries(schemaSnapshotQueries).map(([name, query]) => `${section(name, query)};`).join('\n')}
${dataStatementsSQL}
\\gexec
SELECT '{"kind":"complete","version":1}' AS record;
ROLLBACK;
`;

const fail = code => { throw new Error(code); };
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('logical_snapshot_unsafe_number');
  return value;
};
const encode = value => JSON.stringify(canonical(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => {
  if (typeof value.schema !== 'string' || typeof value.name !== 'string') fail('logical_snapshot_invalid_identity');
  return encode([value.schema, value.name]);
};

export function fingerprintLogicalSnapshot(input, canonicalizeCheck) {
  if (typeof canonicalizeCheck !== 'function') fail('logical_snapshot_check_parser_missing');
  const bytes = Buffer.from(input);
  if (bytes.length > LOGICAL_SNAPSHOT_MAX_BYTES) fail('logical_snapshot_limit_exceeded');
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) fail('logical_snapshot_invalid_encoding');
  const lines = decoded.trim().split('\n');
  let records;
  try { records = lines.map(line => JSON.parse(line)); } catch { fail('logical_snapshot_invalid_transport'); }
  const complete = records.pop();
  if (complete?.kind !== 'complete' || complete.version !== 1) fail('logical_snapshot_incomplete');
  const schema = new Map(); const tables = new Map(); const sequences = new Map();
  let rowCount = 0;
  for (const record of records) {
    if (record.kind === 'schema') {
      if (!Object.hasOwn(schemaSnapshotQueries, record.section) || schema.has(record.section) || !Array.isArray(record.items)) fail('logical_snapshot_invalid_schema');
      const items = record.items.map(item => {
        if (record.section === 'constraints' && item.kind === 'c') {
          if (typeof item.definition !== 'string') fail('logical_snapshot_invalid_check');
          // Unsupported grammar stays losslessly raw, never replaced by TRUE or
          // an expected definition. Invalid native catalogs must be capturable.
          let definition;
          try {
            const parsed = canonicalizeCheck(item.definition);
            if (typeof parsed !== 'string') throw new Error('invalid_parser_result');
            definition = { parsed };
          }
          catch { definition = { raw: item.definition }; }
          return { ...item, definition };
        }
        return item;
      });
      schema.set(record.section, items.map(encode).sort());
    } else if (record.kind === 'table') {
      const key = identity(record);
      if (tables.has(key) || typeof record.count !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(record.count)) fail('logical_snapshot_invalid_table');
      tables.set(key, { count: record.count, rows: [] });
    } else if (record.kind === 'row') {
      const table = tables.get(identity(record));
      if (!table || typeof record.text !== 'string') fail('logical_snapshot_invalid_row');
      if (++rowCount > LOGICAL_SNAPSHOT_MAX_ROWS) fail('logical_snapshot_limit_exceeded');
      table.rows.push(record.text);
    } else if (record.kind === 'sequence') {
      const key = identity(record);
      if (sequences.has(key) || typeof record.last_value !== 'string' || !/^-?[0-9]+$/u.test(record.last_value) || typeof record.is_called !== 'boolean') fail('logical_snapshot_invalid_sequence');
      sequences.set(key, [record.last_value, record.is_called]);
    } else fail('logical_snapshot_invalid_record');
  }
  if (schema.size !== Object.keys(schemaSnapshotQueries).length) fail('logical_snapshot_incomplete_schema');
  if (schema.get('unsupported').length) fail('logical_snapshot_unsupported_object');
  const relations = schema.get('relations').map(value => JSON.parse(value));
  const expectedTables = relations.filter(row => ['r','p','m'].includes(row.kind)).map(identity).sort();
  const expectedSequences = relations.filter(row => row.kind === 'S').map(identity).sort();
  if (encode(expectedTables) !== encode([...tables.keys()].sort()) || encode(expectedSequences) !== encode([...sequences.keys()].sort())) fail('logical_snapshot_incomplete_data_inventory');
  if (encode(expectedSequences) !== encode(schema.get('sequences').map(value => identity(JSON.parse(value))).sort())) fail('logical_snapshot_incomplete_sequence_inventory');
  const data = [...tables].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, table]) => {
    if (BigInt(table.count) !== BigInt(table.rows.length)) fail('logical_snapshot_row_count_mismatch');
    table.rows.sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const digest = createHash('sha256');
    for (const row of table.rows) digest.update(`${Buffer.byteLength(row)}:`).update(row);
    return [key, table.count, digest.digest('hex')];
  });
  // Full sequence parameters are in both schema and data; read state is data.
  return {
    schema: hash(encode([...schema].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0))),
    data: hash(encode({ tables: data, sequences: [...sequences].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0), sequenceParameters: schema.get('sequences') })),
  };
}

// Test adapter executes the exact production SELECTs, without psql meta commands.
export async function captureLogicalSnapshotWithClient(client, canonicalizeCheck) {
  await client.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.exec(logicalSnapshotSettings);
    const lines = [];
    for (const [name, query] of Object.entries(schemaSnapshotQueries)) {
      const result = await client.query(section(name, query));
      lines.push(...result.rows.map(row => row.record));
    }
    const statements = await client.query(dataStatementsSQL);
    for (const row of statements.rows) {
      const results = await client.exec(row.statement);
      for (const result of results) lines.push(...result.rows.map(value => value.record));
    }
    lines.push('{"kind":"complete","version":1}');
    return fingerprintLogicalSnapshot(lines.join('\n'), canonicalizeCheck);
  } finally { await client.exec('ROLLBACK'); }
}
