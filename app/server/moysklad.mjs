import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'

export const HOUR = 60 * 60 * 1000
const endpoint = 'https://api.moysklad.ru/api/remap/1.2/report/stock/bystore/current'
const externalId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const formats = new Set(['drip', 'mega', 'smol30', 'smol60'])

export function validateConfig(config) {
  if (config?.accounting !== 'physical-excludes-local-movements' || !Array.isArray(config.stores) ||
    !config.stores.length || config.stores.some((id) => typeof id !== 'string' || !externalId.test(id)) ||
    !Array.isArray(config.items) || !config.items.length) {
    throw new Error('Укажите склады, сопоставления и проверенный режим учёта МоегоСклада')
  }
  const sources = new Set()
  const targets = new Set()
  for (const row of config.items) {
    if (!row || typeof row.assortmentId !== 'string' || !externalId.test(row.assortmentId) ||
      typeof row.lotId !== 'string' || !row.lotId.trim() || !formats.has(row.formatId) ||
      typeof row.purpose !== 'string' || !row.purpose.trim() || !Number.isSafeInteger(row.unitsPerItem) || row.unitsPerItem < 1) {
      throw new Error('Некорректное сопоставление товара, лота, формата или единицы МоегоСклада')
    }
    const target = JSON.stringify([row.lotId, row.formatId, row.purpose])
    if (sources.has(row.assortmentId) || targets.has(target)) throw new Error('Повторное сопоставление товара или лота')
    sources.add(row.assortmentId)
    targets.add(target)
  }
  return config
}

export async function fetchMoySkladStock(config, token, fetchImpl = fetch) {
  const url = new URL(endpoint)
  url.searchParams.set('stockType', 'stock')
  url.searchParams.set('include', 'zeroLines')
  url.searchParams.set('withRecalculate', 'true')
  url.searchParams.set('filter', `storeId=${config.stores.join(',')}`)
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip', Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000), redirect: 'error',
  })
  if (!response.ok) throw new Error(`МойСклад вернул ошибку HTTP ${response.status}`)
  const raw = await response.json()
  if (!Array.isArray(raw)) throw new Error('Неизвестный формат отчёта об остатках МоегоСклада')
  const stores = new Set(config.stores)
  const items = new Set(config.items.map(({ assortmentId }) => assortmentId))
  const seen = new Set()
  const totals = new Map()
  for (const row of raw) {
    if (!items.has(row?.assortmentId) || !stores.has(row.storeId)) continue
    const key = JSON.stringify([row.assortmentId, row.storeId])
    if (seen.has(key) || !Number.isFinite(row.stock) || row.stock < 0) throw new Error('Остатки МоегоСклада содержат дубли или некорректные значения')
    seen.add(key)
    totals.set(row.assortmentId, (totals.get(row.assortmentId) ?? 0) + row.stock)
  }
  return config.items.map(({ assortmentId, lotId, formatId, purpose, unitsPerItem }) => {
    const quantity = (totals.get(assortmentId) ?? 0) * unitsPerItem
    if (!Number.isSafeInteger(quantity)) throw new Error('Остаток не переводится в целое число дрипов')
    return { lotId, formatId, purpose, quantity }
  })
}

export async function createStockService({ readStock, cachePath, now = () => new Date(), schedule = setInterval, cancelSchedule = clearInterval }) {
  let latest
  let pending
  if (cachePath) {
    try {
      latest = JSON.parse(await readFile(cachePath, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }
  async function load() {
    const startedAt = now().toISOString()
    const rows = await readStock()
    const snapshot = { id: randomUUID(), startedAt, fetchedAt: now().toISOString(), rows }
    if (cachePath) {
      const temporary = `${cachePath}.tmp`
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 })
      await rename(temporary, cachePath)
    }
    latest = snapshot
    return snapshot
  }
  function refresh() {
    if (!pending) pending = load().finally(() => { pending = undefined })
    return pending
  }
  function start(onError) {
    void refresh().catch(onError)
    const timer = schedule(() => { void refresh().catch(onError) }, HOUR)
    return () => cancelSchedule(timer)
  }
  return { refresh, start, latest: () => latest }
}
