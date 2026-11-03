export function assertEmptyMigrationDatabase(objects) {
  if (objects.length > 0) {
    throw new Error('Migration setup requires an empty disposable database; no database objects are dropped');
  }
}
