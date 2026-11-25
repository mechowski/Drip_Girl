import { available, nowIso, uid } from '@/domain/calculations'
import { assemblyParticipantIds, assemblyParticipantNames } from '@/domain/assemblyReports'
import { reportedExpected } from '@/domain/expectedOutput'
import type { AssemblyTask, ExpectedReservation, InventoryLot, StockReservation } from '@/domain/types'
import { db } from './db'

type ReservationTask = Pick<AssemblyTask, 'id' | 'compositionId' | 'isDemo'>

export async function reserveInventory(lot: InventoryLot, task: ReservationTask, itemId: string, quantity: number, createdAt: string) {
  if (available(lot) < quantity) throw new Error('Сток изменился. Пересчитайте план')
  const reservation: StockReservation = {
    id: uid(), assemblyTaskId: task.id, compositionId: task.compositionId, compositionItemId: itemId,
    inventoryLotId: lot.id, quantity, consumedQuantity: 0, status: 'active', createdAt, isDemo: task.isDemo,
  }
  await db.reservations.add(reservation)
  await db.inventory.update(lot.id, { reserved: lot.reserved + quantity })
  await db.inventoryTransactions.add({
    id: uid(), inventoryLotId: lot.id, type: 'reserve', quantity, previousQuantity: lot.quantity,
    newQuantity: lot.quantity, previousReserved: lot.reserved, newReserved: lot.reserved + quantity,
    assemblyTaskId: task.id, author: 'Администратор', createdAt, isDemo: task.isDemo,
  })
  return reservation
}

export async function consumeReservedInventory(reservation: StockReservation, amount: number, report: {
  id: string
  author: string
  reason?: string
  isDemo?: boolean
}) {
  const lot = await db.inventory.get(reservation.inventoryLotId)
  if (!lot || lot.quantity < amount || lot.reserved < amount || reservation.quantity - reservation.consumedQuantity < amount) {
    throw new Error('Резерв повреждён: операция отменена')
  }
  await db.inventory.update(lot.id, { quantity: lot.quantity - amount, reserved: lot.reserved - amount })
  const consumedQuantity = reservation.consumedQuantity + amount
  await db.reservations.update(reservation.id, { consumedQuantity, status: consumedQuantity === reservation.quantity ? 'completed' : 'active' })
  await db.inventoryTransactions.add({
    id: uid(), inventoryLotId: lot.id, type: 'consume', quantity: -amount, previousQuantity: lot.quantity,
    newQuantity: lot.quantity - amount, previousReserved: lot.reserved, newReserved: lot.reserved - amount,
    assemblyTaskId: reservation.assemblyTaskId, reportId: report.id, author: report.author, reason: report.reason, createdAt: nowIso(), isDemo: report.isDemo,
  })
  return { inventoryLotId: lot.id, reservationId: reservation.id, quantity: amount, manufacturedAt: lot.manufacturedAt }
}

const byCreation = (a: ExpectedReservation, b: ExpectedReservation) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

// The caller holds the same transaction as the production receipt and the reports.
export async function settleExpectedReservations(batch: InventoryLot) {
  const claims = (await db.expectedReservations.where('productionTaskId').equals(batch.productionTaskId)
    .filter(({ purpose }) => purpose === batch.purpose).toArray()).sort(byCreation)
  if (!claims.length) return

  let remaining = batch.quantity
  async function reserve(claim: ExpectedReservation, amount: number) {
    const [lot, task] = await Promise.all([db.inventory.get(batch.id), db.assemblyTasks.get(claim.assemblyTaskId)])
    if (!lot || !task) throw new Error('Связь с ожидаемым резервом повреждена')
    const reservation = await reserveInventory(lot, task, claim.compositionItemId, amount, batch.createdAt)
    claim.quantity -= amount
    remaining -= amount
    return reservation
  }

  // Cover assembly already reported before reserving the rest of the receipt for future assembly.
  for (const claim of claims) {
    for (const pending of claim.reported) {
      const amount = Math.min(remaining, pending.quantity)
      if (!amount) break
      const report = await db.assemblyReports.get(pending.reportId)
      if (!report || report.taskId !== claim.assemblyTaskId) throw new Error('Связь с отчётом сборки повреждена')
      const employees = (await db.employees.bulkGet(assemblyParticipantIds(report))).filter((employee) => employee !== undefined)
      const reservation = await reserve(claim, amount)
      const deduction = await consumeReservedInventory(reservation, amount, {
        id: report.id, author: report.recordedBy === 'administrator' ? 'Администратор' : assemblyParticipantNames(report, employees).join(', '),
        reason: 'Выпуск внесён после отчёта о сборке', isDemo: report.isDemo,
      })
      await db.assemblyReports.update(report.id, { deductions: [...report.deductions, deduction] })
      pending.quantity -= amount
    }
    claim.reported = claim.reported.filter(({ quantity }) => quantity > 0)
  }
  for (const claim of claims) {
    const amount = Math.min(remaining, claim.quantity - reportedExpected(claim))
    if (amount > 0) await reserve(claim, amount)
    await saveExpectedReservation(claim)
  }
}

async function saveExpectedReservation(claim: ExpectedReservation) {
  if (claim.quantity > 0) await db.expectedReservations.put(claim)
  else await db.expectedReservations.delete(claim.id)
}

export async function reportAgainstExpected(taskId: string, itemId: string, reportId: string, needed: number) {
  const claims = (await db.expectedReservations.where('assemblyTaskId').equals(taskId)
    .filter(({ compositionItemId }) => compositionItemId === itemId).toArray()).sort(byCreation)
  for (const claim of claims) {
    const amount = Math.min(needed, claim.quantity - reportedExpected(claim))
    if (!amount) continue
    const pending = claim.reported.find((row) => row.reportId === reportId)
    if (pending) pending.quantity += amount
    else claim.reported.push({ reportId, quantity: amount })
    await db.expectedReservations.put(claim)
    needed -= amount
    if (!needed) break
  }
  return needed
}

export async function restoreExpectedDeduction(task: AssemblyTask, itemId: string, reportId: string, needed: number) {
  const claims = (await db.expectedReservations.where('assemblyTaskId').equals(task.id)
    .filter(({ compositionItemId }) => compositionItemId === itemId).toArray()).sort(byCreation).reverse()
  for (const claim of claims) {
    const pending = claim.reported.find((row) => row.reportId === reportId)
    if (!pending) continue
    const amount = Math.min(needed, pending.quantity)
    pending.quantity -= amount
    claim.reported = claim.reported.filter(({ quantity }) => quantity > 0)
    if (task.status === 'cancelled') claim.quantity -= amount
    await saveExpectedReservation(claim)
    needed -= amount
    if (!needed) break
  }
  return needed
}

export async function releaseExpectedReservations(taskId: string) {
  for (const claim of await db.expectedReservations.where('assemblyTaskId').equals(taskId).toArray()) {
    claim.quantity = reportedExpected(claim)
    await saveExpectedReservation(claim)
  }
}
