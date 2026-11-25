import { prepareBackup } from '../src/persistence/db'
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '../src/domain/types'
import { db, tableNames } from './repository-store.mjs'

function redactSettings(row: Record<string, unknown>) {
  const safe = { ...row }
  delete safe.adminPassword
  return safe
}

export function previewBackup(input: unknown) {
  const data = prepareBackup(input)
  return Object.fromEntries(tableNames.map(name => [name, data[name].length]))
}

export async function importServerBackup(input: unknown) {
  const data = prepareBackup(input)
  return db.transaction('rw', db.tables, async () => {
    for (const name of tableNames) {
      if ((await db[name].toArray()).length) throw new Error('Импорт доступен только в пустую серверную базу')
    }
    for (const name of tableNames) {
      const rows = name === 'settings' ? data[name].map(row => redactSettings(row as Record<string, unknown>)) : data[name]
      await db[name].bulkAdd(rows)
    }
  })
}

export async function exportServerBackup() {
  return db.transaction('r', db.tables, async () => {
    const entries = await Promise.all(tableNames.map(async name => {
      const rows = await db[name].toArray()
      return [name, name === 'settings' ? (rows.length ? rows : [DEFAULT_SETTINGS]).map(redactSettings) : rows]
    }))
    return { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data: Object.fromEntries(entries) }
  })
}

export async function markWarning(id: string, read: boolean) {
  return db.transaction('rw', db.tables, () => db.warnings.update(id, { read }))
}

export function resetServerData() {
  return db.transaction('rw', db.tables, async () => {
    for (const name of tableNames) await db[name].clear()
  })
}
