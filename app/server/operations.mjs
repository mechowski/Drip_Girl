import { createHash } from 'node:crypto'

export class OperationConflict extends Error {
  constructor() {
    super('Этот ключ уже использован для другой операции')
  }
}

// actorId must come from the authenticated server session. Retries reuse the same request bytes.
export async function runOperation(pool, { actorId, key, command, body }, apply) {
  const requestHash = createHash('sha256').update(command).update('\0').update(body).digest('hex')
  const client = await pool.connect()
  let discard = false
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    // The unique key serializes concurrent retries, including the first insert.
    const claim = await client.query(
      `INSERT INTO operation_receipts (actor_id, operation_key, request_hash, result)
       VALUES ($1, $2, $3, 'null')
       ON CONFLICT (actor_id, operation_key) DO NOTHING`,
      [actorId, key, requestHash],
    )
    if (!claim.rowCount) {
      const { rows: [receipt] } = await client.query(
        'SELECT request_hash, result FROM operation_receipts WHERE actor_id = $1 AND operation_key = $2',
        [actorId, key],
      )
      if (receipt.request_hash !== requestHash) throw new OperationConflict()
      await client.query('COMMIT')
      return receipt.result
    }

    const result = JSON.stringify((await apply(client)) ?? null)
    await client.query(
      'UPDATE operation_receipts SET result = $3 WHERE actor_id = $1 AND operation_key = $2',
      [actorId, key, result],
    )
    await client.query('COMMIT')
    return JSON.parse(result)
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      discard = true
    }
    throw error
  } finally {
    client.release(discard)
  }
}
