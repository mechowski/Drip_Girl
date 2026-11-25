import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { expectedSchemaVersion, listMigrations } from './schema.mjs'

const connectionString = process.env.MIGRATION_DATABASE_URL
if (!connectionString) {
  console.error('Задайте MIGRATION_DATABASE_URL с ролью владельца схемы')
  process.exit(1)
}

const client = new pg.Client({ connectionString })
await client.connect()
try {
  await client.query('SELECT pg_advisory_lock(730001)')
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
    REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM drip_girl_app
  `)
  const applied = new Set(
    (await client.query('SELECT version FROM schema_migrations')).rows.map((row) => row.version),
  )
  const migrations = await listMigrations()
  let appliedCount = 0
  for (const { version, file } of migrations) {
    if (applied.has(version)) continue
    const sql = await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8')
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [version, file])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    console.log(`Применена миграция ${file}`)
    appliedCount += 1
  }
  const expected = expectedSchemaVersion(migrations)
  console.log(appliedCount ? `Схема обновлена до версии ${expected}` : `Новых миграций нет, схема на версии ${expected}`)
} finally {
  await client.end()
}
