export type ImportPreflightCode = 'import_apply_not_ready' | 'import_configuration_required' |
  'import_local_database_required' | 'import_database_identity_unavailable' | 'import_source_is_destination' |
  'import_database_name_mismatch' | 'import_database_schema_mismatch' | 'import_source_authority_changed' |
  'import_source_destination_same_database' |
  'import_storage_overlap' | 'import_database_unavailable'

export class ImportPreflightError extends Error {
  constructor(readonly code: ImportPreflightCode) { super(code) }
}
