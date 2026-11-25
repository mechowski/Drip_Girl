import { AsyncLocalStorage } from 'node:async_hooks'

const transactions = new AsyncLocalStorage()
const writeLock = 730002

export function createPostgresStore(pool, names) {
  function table(name) {
    const sqlName = name.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase())
    const query = (sql, values) => {
      const scope = transactions.getStore()
      if (!scope || scope.pool !== pool) throw new Error('Database access requires a transaction')
      const result = scope.pending.then(() => scope.client.query(sql, values))
      scope.pending = result.catch(() => {})
      return result
    }

    async function toArray() {
      const { rows } = await query(`SELECT data FROM ${sqlName} ORDER BY id COLLATE "C"`)
      return rows.map(row => row.data)
    }

    async function write(row, replace) {
      const conflict = replace ? 'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data' : ''
      const data = { ...row }
      if (name === 'settings') delete data.adminPassword
      await query(`INSERT INTO ${sqlName} (id, data) VALUES ($1, $2) ${conflict}`, [row.id, data])
      return row.id
    }

    async function get(id) {
      const { rows } = await query(`SELECT data FROM ${sqlName} WHERE id = $1`, [id])
      return rows[0]?.data
    }

    function collection(matches) {
      const read = async () => (await toArray()).filter(matches)
      return {
        toArray: read,
        filter: predicate => collection(row => matches(row) && predicate(row)),
        first: async () => (await read())[0],
        count: async () => (await read()).length,
        async delete() {
          const rows = await read()
          await query(`DELETE FROM ${sqlName} WHERE id = ANY($1::text[])`, [rows.map(row => row.id)])
          return rows.length
        },
        async modify(change) {
          const rows = await read()
          for (const row of rows) {
            if (typeof change === 'function') change(row)
            else Object.assign(row, change)
            await write(row, true)
          }
          return rows.length
        },
      }
    }

    return {
      name,
      toArray,
      get,
      filter: collection,
      toCollection: () => collection(() => true),
      where: field => ({
        equals: value => collection(row => row[field] === value),
        anyOf: values => collection(row => values.includes(row[field])),
        aboveOrEqual: value => collection(row => row[field] >= value),
      }),
      add: row => write(row, false),
      put: row => write(row, true),
      async update(id, changes) {
        const row = await get(id)
        if (!row) return 0
        await write({ ...row, ...changes, id }, true)
        return 1
      },
      bulkGet: ids => Promise.all(ids.map(get)),
      bulkAdd: rows => Promise.all(rows.map(row => write(row, false))),
      bulkPut: rows => Promise.all(rows.map(row => write(row, true))),
      delete: id => query(`DELETE FROM ${sqlName} WHERE id = $1`, [id]),
      bulkDelete: ids => query(`DELETE FROM ${sqlName} WHERE id = ANY($1::text[])`, [ids]),
      clear: () => query(`DELETE FROM ${sqlName}`),
    }
  }

  if (names.some(name => !/^[a-z][a-zA-Z]*$/.test(name))) throw new Error('Invalid table name')
  const tables = names.map(table)
  const byName = Object.fromEntries(tables.map(item => [item.name, item]))

  async function useTransaction(client, writable, operation, isAdmin = false) {
    const scope = { pool, client, writable, isAdmin, pending: Promise.resolve() }
    try { return await transactions.run(scope, operation) } finally { await scope.pending }
  }

  return {
    ...byName,
    table: name => byName[name],
    tables,
    async runWrite(client, operation, isAdmin) {
      await client.query('SELECT pg_advisory_xact_lock($1)', [writeLock])
      return useTransaction(client, true, operation, isAdmin)
    },
    hasAdminSession: () => transactions.getStore()?.isAdmin === true,
    async transaction(mode, ...args) {
      const operation = args.at(-1)
      const writable = mode === 'rw'
      const scope = transactions.getStore()
      if (scope?.pool === pool) {
        if (writable && !scope.writable) throw new Error('Cannot write in a read-only transaction')
        return operation()
      }

      const client = await pool.connect()
      let discard = false
      try {
        await client.query(writable ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        // Until individual commands lock their rows, serialize writes across this database.
        if (writable) await client.query('SELECT pg_advisory_xact_lock($1)', [writeLock])
        const result = await useTransaction(client, writable, operation)
        await client.query('COMMIT')
        return result
      } catch (error) {
        try { await client.query('ROLLBACK') } catch { discard = true }
        throw error
      } finally {
        client.release(discard)
      }
    },
  }
}
