import pg from 'pg'

export function createPool(connectionString) {
  const requested = Number(process.env.PG_POOL_MAX ?? 4)
  const pool = new pg.Pool({
    connectionString,
    max: Number.isInteger(requested) && requested > 0 ? Math.min(requested, 4) : 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })
  pool.on('error', (error) => console.error('Соединение с базой:', error.message))
  return pool
}
