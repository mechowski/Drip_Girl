import { z } from 'zod'
import { hasAdminSession } from '@/domain/adminSession'
import { isPrivateLabel, nowIso, uid } from '@/domain/calculations'
import type { FormatId } from '@/domain/types'
import { db } from './db'
import { productionEntryForBatch } from './productionCorrection'

const mapping = z.object({
  lotId: z.string().min(1),
  formatId: z.enum(['drip', 'mega', 'smol30', 'smol60']),
  purpose: z.string().min(1),
  quantity: z.number().int().nonnegative(),
})

const stockSnapshot = z.object({
  id: z.string().min(1), startedAt: z.iso.datetime({ offset: true }), fetchedAt: z.iso.datetime({ offset: true }),
  rows: z.array(mapping).min(1),
})
const stockKey = (lotId: string, formatId: FormatId, purpose: string) => JSON.stringify([lotId, formatId, purpose])

export async function updateMoySkladEntry(entryId: string, posted: boolean, rawLink: string) {
  if (!hasAdminSession()) throw new Error('Отметку может изменить только администратор')
  const link = rawLink.trim()
  if (link && !z.httpUrl().safeParse(link).success) throw new Error('Укажите ссылку с http:// или https://')
  return db.transaction('rw', db.productionEntries, db.auditEvents, async () => {
    const entry = await db.productionEntries.get(entryId)
    if (!entry) throw new Error('Партия выпуска не найдена')
    const markChanged = Boolean(entry.moySkladPosted) !== posted
    if (!markChanged && (entry.moySkladLink ?? '') === link) return false
    const changedAt = nowIso()
    await db.productionEntries.update(entryId, {
      moySkladPosted: posted, moySkladLink: link || undefined,
      moySkladPostedAt: markChanged ? changedAt : entry.moySkladPostedAt,
    })
    await db.auditEvents.add({
      id: uid(), action: 'update', entityType: 'production', entityId: entryId, createdAt: changedAt, isDemo: entry.isDemo,
      description: posted ? 'Партия отмечена как проведённая в МоемСкладе' : 'Партия ожидает проведения в МоемСкладе',
    })
    return markChanged && posted && !(await db.productionEntries.filter((row) =>
      row.quantity > 0 && Boolean(row.isDemo) === Boolean(entry.isDemo) && !row.moySkladPosted).first())
  })
}

export async function applyMoySkladSnapshot(input: unknown) {
  const snapshot = stockSnapshot.parse(input)
  return db.transaction('rw', db.tables, async () => {
    const settings = await db.settings.get('settings')
    if (!settings) throw new Error('Настройки стока не найдены')
    if (settings.moySkladSnapshotId === snapshot.id || (settings.moySkladSyncedAt && Date.parse(settings.moySkladSyncedAt) >= Date.parse(snapshot.fetchedAt))) return
    const entries = await db.productionEntries.toArray()
    const inventory = await db.inventory.toArray()
    const external = new Map(inventory.flatMap((row) => row.moySkladKey ? [[row.moySkladKey, row] as const] : []))
    const rowsByKey = new Map(snapshot.rows.map((row) => [stockKey(row.lotId, row.formatId, row.purpose), row]))
    if (rowsByKey.size !== snapshot.rows.length || [...external.keys()].some((key) => !rowsByKey.has(key))) {
      throw new Error('Сверьте сопоставления МоегоСклада: снимок содержит дубли или в нём отсутствует ранее подключённый лот')
    }
    const tasks = new Map((await db.productionTasks.toArray()).map((task) => [task.id, task]))
    const receipts = new Map<string, number>()
    const updated = []
    for (const entry of entries) {
      if (entry.isDemo) continue
      const changedBeforeRead = entry.moySkladPostedAt && Date.parse(entry.moySkladPostedAt) <= Date.parse(snapshot.startedAt)
      const applied = changedBeforeRead ? Boolean(entry.moySkladPosted) : Boolean(entry.moySkladApplied)
      if (applied) {
        const task = tasks.get(entry.taskId)
        const purposes = entry.purposeQuantities ?? (task?.purpose ? { [task.purpose]: entry.quantity } : undefined)
        if (!task || !purposes || Object.values(purposes).reduce((sum, value) => sum + value, 0) !== entry.quantity) {
          throw new Error('Сверьте назначения проведённой партии')
        }
        for (const [purpose, quantity] of Object.entries(purposes)) {
          if (!quantity) continue
          const key = stockKey(entry.lotId, task.formatId, purpose)
          if (!rowsByKey.has(key)) throw new Error('Добавьте сопоставление для проведённой партии перед обновлением')
          const batch = inventory.find((row) => !row.moySkladKey && row.sourceLotId === entry.lotId && productionEntryForBatch(row, entries)?.id === entry.id)
          if (!batch) throw new Error('Не найдена исходная партия проведённого выпуска')
          receipts.set(key, (receipts.get(key) ?? 0) + quantity)
        }
      }
      if (applied !== Boolean(entry.moySkladApplied)) updated.push({ ...entry, moySkladApplied: applied })
    }

    for (const [key, row] of rowsByKey) {
      const lot = await db.lots.get(row.lotId)
      if (!lot || lot.isDemo) throw new Error('Сопоставленный рабочий лот не найден')
      const batch = external.get(key)
      const newBase = row.quantity - (receipts.get(key) ?? 0)
      // Keep the net movements already made against the external batch.
      const quantity = newBase + (batch ? batch.quantity - (batch.moySkladBase ?? 0) : 0)
      if (newBase < 0 || !Number.isSafeInteger(quantity) || quantity < (batch?.reserved ?? 0)) {
        throw new Error(`${lot.country} / ${lot.name}: снимок не покрывает проведённые партии, локальные списания или активный резерв`)
      }
      const id = batch?.id ?? uid()
      if (batch) await db.inventory.update(id, { quantity, moySkladBase: newBase })
      else await db.inventory.add({
        id, sourceLotId: lot.id, productionTaskId: 'moysklad', formatId: row.formatId, purpose: row.purpose,
        country: lot.country, coffeeName: lot.name, quantity, reserved: 0, shared: !isPrivateLabel(row.purpose),
        manufacturedAt: new Date(`${lot.roastDate}T00:00:00Z`).toISOString(), createdAt: snapshot.fetchedAt,
        inBU: false, moySkladKey: key, moySkladBase: newBase,
      })
      if (quantity !== (batch?.quantity ?? 0)) await db.inventoryTransactions.add({
        id: uid(), inventoryLotId: id, type: 'adjust', quantity: quantity - (batch?.quantity ?? 0), previousQuantity: batch?.quantity ?? 0,
        newQuantity: quantity, reason: 'Снимок остатков МоегоСклада', author: 'МойСклад', createdAt: snapshot.fetchedAt,
      })
    }
    await db.productionEntries.bulkPut(updated)
    await db.settings.put({ ...settings, moySkladSyncedAt: snapshot.fetchedAt, moySkladSnapshotId: snapshot.id })
  })
}

export async function refreshMoySklad(force = false) {
  const response = await fetch('/api/moysklad/stock', { method: force ? 'POST' : 'GET', headers: { Accept: 'application/json' } })
  if (response.status === 204) return
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Сервер МоегоСклада недоступен')
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Не удалось загрузить остатки')
  await applyMoySkladSnapshot(result)
}
