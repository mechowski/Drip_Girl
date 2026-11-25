import { hasAdminSession } from '@/domain/adminSession'
import { coffeeDiscrepancy, nowIso, remainingCoffee, uid } from '@/domain/calculations'
import type { InventoryLot, ProductionEntry } from '@/domain/types'
import { db } from './db'
import { settleExpectedReservations } from './stockReservations'

export class ProductionCorrectionConflict extends Error {
  readonly taskIds: string[]
  readonly reportIds: string[]

  constructor(message: string, taskIds: string[] = [], reportIds: string[] = []) {
    super(message)
    this.taskIds = taskIds
    this.reportIds = reportIds
  }
}

// Older releases did not store the entry id on receipts. Match only when the timestamp identifies one entry.
export function productionEntryForBatch(batch: InventoryLot, entries: ProductionEntry[]) {
  if (batch.productionEntryId) return entries.find(({ id }) => id === batch.productionEntryId)
  const matches = entries.filter((entry) => entry.taskId === batch.productionTaskId && entry.createdAt === batch.manufacturedAt)
  return matches.length === 1 ? matches[0] : undefined
}

export async function correctProductionEntry(entryId: string, newQuantity: number, reason: string, expectedQuantity?: number) {
  if (!Number.isSafeInteger(newQuantity) || newQuantity < 0 || !reason.trim()) throw new Error('Укажите целое неотрицательное количество и причину')
  await db.transaction('rw', db.tables, async () => {
    if (!hasAdminSession()) throw new Error('Исправить выпуск может только администратор')
    const entry = await db.productionEntries.get(entryId)
    const archive = await db.dailyReports.filter((report) => report.produced.some(({ id }) => id === entryId)).first()
    if (!entry || !archive) throw new Error('Выпуск в закрытой смене не найден')
    if (expectedQuantity !== undefined && entry.quantity !== expectedQuantity) throw new Error('Выпуск уже изменился. Откройте его заново')
    const delta = newQuantity - entry.quantity
    if (!delta) throw new Error('Количество не изменилось')
    if (entry.moySkladPosted || entry.moySkladApplied) throw new Error('Выпуск отмечен как проведённый в МоемСкладе. Сначала сверьте техоперацию и снимите отметку')
    const task = await db.productionTasks.get(entry.taskId)
    const settings = await db.settings.get('settings')
    const format = settings?.formats.find(({ id }) => id === task?.formatId)
    if (!task || !format) throw new Error('Не найдена производственная задача или её формат')
    const entries = await db.productionEntries.where('taskId').equals(task.id).toArray()
    const batches = (await db.inventory.where('productionTaskId').equals(task.id).toArray())
      .filter((batch) => productionEntryForBatch(batch, entries)?.id === entry.id)
    const events = await db.inventoryTransactions.where('inventoryLotId').anyOf(batches.map(({ id }) => id)).toArray()
    const conflict = (message: string) => new ProductionCorrectionConflict(message,
      [...new Set(events.flatMap(({ assemblyTaskId }) => assemblyTaskId ? [assemblyTaskId] : []))],
      [...new Set(events.flatMap(({ reportId }) => reportId ? [reportId] : []))])
    const receiptIds = new Set(events.filter(({ type }) => type === 'receipt').map(({ inventoryLotId }) => inventoryLotId))
    const originals = batches.filter(({ id }) => receiptIds.has(id)).sort((a, b) => a.purpose.localeCompare(b.purpose) || a.id.localeCompare(b.id))
    if (!originals.length || (delta < 0 && events.some(({ type }) => type === 'reassign'))) {
      throw conflict('Исходные партии нельзя однозначно восстановить. Сверьте историю лота и переназначения')
    }
    const purposeQuantities = { ...(entry.purposeQuantities ?? Object.fromEntries(originals.map((batch) =>
      [batch.purpose, events.find((event) => event.inventoryLotId === batch.id && event.type === 'receipt')!.quantity]))) }
    const ordered = [...Object.keys(purposeQuantities)]
    if (ordered.reduce((sum, key) => sum + purposeQuantities[key], 0) !== entry.quantity) throw conflict('Сведения о приходе расходятся с фактом выпуска')
    const changes = new Map<string, number>()
    if (delta > 0) {
      const purpose = task.purpose ?? ordered.at(-1) ?? originals[0].purpose
      changes.set(purpose, delta)
    } else {
      let needed = -delta
      for (const purpose of ordered.reverse()) {
        const amount = Math.min(needed, purposeQuantities[purpose])
        if (amount) changes.set(purpose, -amount)
        needed -= amount
        if (!needed) break
      }
    }
    const at = nowIso()
    const consumed = new Map<string, number>()
    if (delta < 0) {
      const batchIds = new Set(batches.map(({ id }) => id))
      for (const report of await db.assemblyReports.toArray()) {
        for (const row of report.deductions) {
          if (batchIds.has(row.inventoryLotId)) consumed.set(row.inventoryLotId, (consumed.get(row.inventoryLotId) ?? 0) + row.quantity)
        }
      }
    }
    for (const [purpose, change] of changes) {
      const original = originals.find((batch) => batch.purpose === purpose)
      if (!original || originals.filter((batch) => batch.purpose === purpose).length !== 1) throw conflict('Сверьте назначение исходной партии')
      const targets = batches.filter((batch) => batch.purpose === purpose)
        .sort((a, b) => Number(a.id === original.id) - Number(b.id === original.id) || b.createdAt.localeCompare(a.createdAt))
      if (change < 0) {
        const available = targets.reduce((sum, row) => sum + row.quantity - row.reserved, 0)
        const used = targets.reduce((sum, row) => sum + row.reserved + (consumed.get(row.id) ?? 0), 0)
        if (available < -change || purposeQuantities[purpose] + change < used) {
          throw conflict(`Нельзя уменьшить выпуск с ${entry.quantity} до ${newQuantity}: нужные дрипы уже списаны или зарезервированы`)
        }
      }
      purposeQuantities[purpose] = (purposeQuantities[purpose] ?? 0) + change
      if (change > 0) {
        const batch: InventoryLot = { ...original, id: uid(), productionEntryId: entryId, quantity: change, reserved: 0, createdAt: at }
        await db.inventory.add(batch)
        await db.inventoryTransactions.add({ id: uid(), inventoryLotId: batch.id, type: 'adjust', quantity: change, previousQuantity: 0, newQuantity: change, author: 'Администратор', reason: reason.trim(), createdAt: at, isDemo: entry.isDemo })
        await settleExpectedReservations(batch)
      } else {
        let left = -change
        for (const batch of targets) {
          const amount = Math.min(left, batch.quantity - batch.reserved)
          if (!amount) continue
          const quantity = batch.quantity - amount
          await db.inventory.update(batch.id, { quantity, productionEntryId: entryId })
          await db.inventoryTransactions.add({ id: uid(), inventoryLotId: batch.id, type: 'adjust', quantity: -amount, previousQuantity: batch.quantity, newQuantity: quantity, author: 'Администратор', reason: reason.trim(), createdAt: at, isDemo: entry.isDemo })
          left -= amount
          if (!left) break
        }
      }
    }
    const updated = { ...entry, quantity: newQuantity, purposeQuantities }
    const producedQuantity = task.producedQuantity + delta
    if (!Number.isSafeInteger(producedQuantity) || producedQuantity < 0) throw conflict('Факт выпуска расходится с суммой производственной задачи')
    const changed = { ...task, producedQuantity }
    const nextEntries = entries.map((row) => row.id === entry.id ? updated : row)
    const status = task.status === 'cancelled' ? task.status : producedQuantity >= task.plannedQuantity || remainingCoffee(changed, format, nextEntries) <= 1e-9
      ? 'completed' : 'open'
    await db.productionEntries.put(updated)
    await db.productionTasks.update(task.id, { producedQuantity, status })
    await db.dailyReports.update(archive.id, { produced: archive.produced.map((row) => row.id === entry.id ? updated : row) })
    await db.adjustments.add({ id: uid(), entityType: 'production', entityId: entry.id, previousValue: entry.quantity, newValue: newQuantity, reason: reason.trim(), author: 'Администратор', createdAt: at, isDemo: entry.isDemo })
    const description = `Выпуск исправлен: ${entry.quantity} → ${newQuantity}. ${reason.trim()}`
    await db.auditEvents.add({ id: uid(), action: 'correct', entityType: 'production', entityId: entry.id, description, createdAt: at, isDemo: entry.isDemo })
    if (coffeeDiscrepancy(changed, format, nextEntries)) {
      await db.warnings.add({ id: uid(), type: 'discrepancy', message: description, read: false, lotId: entry.lotId, taskId: task.id, createdAt: at, isDemo: entry.isDemo })
    }
  })
}
