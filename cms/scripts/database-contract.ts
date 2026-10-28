export function parsePortalDatabaseName(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/u.test(raw)) {
    throw new Error('Invalid CMS Portal database name')
  }
  return raw
}

export function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function quotePostgresLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
