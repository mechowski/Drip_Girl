import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { expectedSchemaVersion, listMigrations, schemaStatus } from './schema.mjs'

test('миграции читаются в порядке версий', async () => {
  const migrations = await listMigrations()
  assert.ok(migrations.length >= 1)
  const versions = migrations.map(({ version }) => version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(expectedSchemaVersion(migrations), versions.at(-1))
})

test('первая миграция создаёт таблицы под все таблицы Dexie', async () => {
  const sql = await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8')
  const tables = [
    'lots', 'allocations', 'production_tasks', 'production_entries', 'inventory',
    'inventory_transactions', 'reservations', 'expected_reservations', 'aliases',
    'sheet_connections', 'imported_compositions', 'manual_compositions', 'assembly_plans',
    'assembly_tasks', 'assembly_reports', 'employees', 'production_days', 'daily_reports',
    'warnings', 'adjustments', 'audit_events', 'settings',
  ]
  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(`), `нет таблицы ${table}`)
  }
  assert.doesNotMatch(sql, /FOREIGN KEY|REFERENCES/i)
})

test('готовность схемы сверяет применённую и ожидаемую версии', () => {
  assert.deepEqual(schemaStatus(1, 1), { ready: true, schemaVersion: 1 })
  assert.deepEqual(schemaStatus(3, 2), { ready: true, schemaVersion: 3 })
  assert.deepEqual(schemaStatus(0, 1), { ready: false, schemaVersion: 0, expectedSchemaVersion: 1 })
  assert.deepEqual(schemaStatus(1, 2), { ready: false, schemaVersion: 1, expectedSchemaVersion: 2 })
  assert.deepEqual(schemaStatus(0, 0), { ready: false, schemaVersion: 0, expectedSchemaVersion: 0 })
})
