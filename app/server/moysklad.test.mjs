import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStockService, fetchMoySkladStock, HOUR, validateConfig } from './moysklad.mjs'

const store = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const product = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const config = {
  accounting: 'physical-excludes-local-movements',
  stores: [store],
  items: [{ assortmentId: product, lotId: 'local-lot', formatId: 'drip', purpose: '×16', unitsPerItem: 2 }],
}

test('читает физический остаток выбранных складов, преобразует единицы и проверяет сопоставления', async () => {
  const fetchImpl = async (url, request) => {
    assert.equal(url.searchParams.get('stockType'), 'stock')
    assert.equal(url.searchParams.get('include'), 'zeroLines')
    assert.equal(url.searchParams.get('withRecalculate'), 'true')
    assert.equal(url.searchParams.get('filter'), `storeId=${store}`)
    assert.equal(request.headers.Authorization, 'Bearer test')
    return Response.json([
      { assortmentId: product, storeId: store, stock: 50 },
      { assortmentId: product, storeId: other, stock: 3 },
    ])
  }
  const value = await fetchMoySkladStock(validateConfig(config), 'test', fetchImpl)
  assert.deepEqual(value, [{ lotId: 'local-lot', formatId: 'drip', purpose: '×16', quantity: 100 }])
  assert.throws(() => validateConfig({ ...config, accounting: 'unknown' }), /режим учёта/)
  await assert.rejects(fetchMoySkladStock(config, 'test', async () => Response.json([{ assortmentId: product, storeId: store, stock: null }])), /некорректные/)
})

test('загружает сток каждый час без браузера, объединяет параллельные запросы и держит удачный снимок при сбое', async () => {
  let nextTick
  let calls = 0
  let fail = false
  let stopped = false
  const errors = []
  const service = await createStockService({
    readStock: async () => { calls++; if (fail) throw new Error('сбой'); return [{ quantity: calls }] },
    schedule: (callback, interval) => { assert.equal(interval, HOUR); nextTick = callback; return 1 },
    cancelSchedule: (id) => { assert.equal(id, 1); stopped = true },
  })
  const stop = service.start((error) => errors.push(error.message))
  assert.equal((await service.refresh()).rows[0].quantity, 1)
  nextTick()
  assert.equal((await service.refresh()).rows[0].quantity, 2)
  fail = true
  nextTick()
  await assert.rejects(service.refresh(), /сбой/)
  assert.equal(service.latest().rows[0].quantity, 2)
  assert.deepEqual(errors, ['сбой'])
  stop()
  assert.equal(stopped, true)
})
