// migrate-old-uniwork.ts — typed re-export of the pure migration core in
// migrate-old-uniwork.mjs. The app imports these names here (extensionless,
// for the tsc/esbuild build); the CI smoke driver imports the .mjs directly
// because Node's type-stripping cannot resolve extensionless TypeScript
// imports.
export {
  MIGRATE_SUBDIRS,
  MIGRATION_TARGET_DIR,
  MIGRATION_COMPLETED_MARKER,
  MIGRATION_LOG_FILE,
  detectOldUniworkUserData,
  copyTreeNoOverwrite,
  migrateOldUniworkData
} from './migrate-old-uniwork.mjs'
