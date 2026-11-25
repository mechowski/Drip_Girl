import { readdir } from 'node:fs/promises'

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url)

export async function listMigrations(dir = MIGRATIONS_DIR) {
  const files = await readdir(dir)
  return files
    .map((file) => /^(\d+)_.*\.sql$/.exec(file))
    .filter(Boolean)
    .map((match) => ({ version: Number(match[1]), file: match[0] }))
    .sort((a, b) => a.version - b.version)
}

export function expectedSchemaVersion(migrations) {
  return migrations.reduce((max, { version }) => Math.max(max, version), 0)
}

export function schemaStatus(appliedVersion, expectedVersion) {
  if (expectedVersion > 0 && appliedVersion >= expectedVersion) {
    return { ready: true, schemaVersion: appliedVersion }
  }
  return { ready: false, schemaVersion: appliedVersion, expectedSchemaVersion: expectedVersion }
}
