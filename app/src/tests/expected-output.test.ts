import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminSessionKey } from '@/domain/adminSession'
import { expectedOutput, previewAssemblyReservation } from '@/domain/expectedOutput'
import { DEFAULT_SETTINGS, type ManualComposition } from '@/domain/types'
import { db, exportBackup, importBackup } from '@/persistence/db'
import { addEmployee, cancelAssemblyTask, confirmAssemblyPlan, correctAssemblyReport, createAssemblyPlan, createLot, produce, reportAssembly, writeOffProduction } from '@/persistence/repository'
import { readAppSnapshot } from '@/persistence/snapshot'

const shiftDate = '2025-10-09'

async function prepare(plannedAfterFirstReceipt = 20) {
  const employee = await addEmployee('Анна', 'Лотова')
  const lot = await createLot({
    country: 'Эфиопия', name: 'Гуджи', roastDate: '2025-10-06', degassingDays: 3,
    weightKg: 0.0121 * (plannedAfterFirstReceipt + 4),
    allocations: [{ formatId: 'drip', purpose: '×16', weightKg: 0.0121 * (plannedAfterFirstReceipt + 4) }],
  })
  const task = (await db.productionTasks.where('lotId').equals(lot.id).first())!
  await produce(task.id, 4, employee.id)
  const composition: ManualComposition = {
    id: 'assembly-composition', name: 'Гуджи ×6', kind: 'x6', createdAt: lot.createdAt, enabled: true,
    items: [{ id: 'guji', country: lot.country, coffeeName: lot.name, inventoryLotId: lot.id, formatId: 'drip', quantityPerSet: 6 }],
  }
  await db.manualCompositions.put(composition)
  return { employee, lot, task, composition }
}

async function draft(composition: ManualComposition, quantity: number, date = shiftDate) {
  const id = await createAssemblyPlan([{ composition, quantity }], date)
  const task = (await db.assemblyTasks.where('planId').equals(id).first())!
  const preview = previewAssemblyReservation([task], await readAppSnapshot(), date, shiftDate)
  return { id, task, preview }
}

function admin() {
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => key === adminSessionKey ? 'yes' : null })
}

describe('резерв под сегодняшний выпуск', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${shiftDate}T12:00:00`))
    await db.transaction('rw', db.tables, async () => { for (const table of db.tables) await table.clear() })
    await db.settings.put(DEFAULT_SETTINGS)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('требует свежего согласия администратора и не обещает один выпуск дважды', async () => {
    const { composition } = await prepare()
    const first = await draft(composition, 2)
    const second = await draft(composition, 3)
    expect(first.preview.expected.map(({ quantity }) => quantity)).toEqual([8])
    expect(second.preview.expected.map(({ quantity }) => quantity)).toEqual([14])
    await expect(confirmAssemblyPlan(first.id, undefined, first.preview.approvalKey)).rejects.toThrow('только администратор')
    admin()
    await expect(confirmAssemblyPlan(first.id)).rejects.toThrow('подтвердите актуальное покрытие')
    await confirmAssemblyPlan(first.id, undefined, first.preview.approvalKey)
    await expect(confirmAssemblyPlan(second.id, undefined, second.preview.approvalKey)).rejects.toThrow('Недостаточно стока')
    expect(await db.expectedReservations.toArray()).toMatchObject([{ quantity: 8, assemblyTaskId: first.task.id, reported: [] }])
    expect((await db.inventory.toArray())[0]).toMatchObject({ quantity: 4, reserved: 4 })
    expect(expectedOutput(await readAppSnapshot(), shiftDate).map(({ quantity }) => quantity)).toEqual([12])
    await expect(cancelAssemblyTask(first.task.id, 'Пересчёт плана')).resolves.toBeUndefined()
    expect(await db.expectedReservations.count()).toBe(0)
    expect((await db.inventory.toArray())[0].reserved).toBe(0)
  })

  it('блокирует недостаточный и чужой по дате или лоту выпуск', async () => {
    const { composition, task } = await prepare(7)
    admin()
    const insufficient = await draft(composition, 2)
    expect(insufficient.preview.shortages.map(({ quantity }) => quantity)).toEqual([8])
    await expect(confirmAssemblyPlan(insufficient.id)).rejects.toThrow('Недостаточно стока')
    await db.productionTasks.update(task.id, { plannedDate: '2025-10-10', plannedQuantity: 24, sourceWeightKg: 0.2904 })
    const tomorrow = await draft(composition, 2)
    expect(tomorrow.preview.expected).toHaveLength(0)
    await expect(confirmAssemblyPlan(tomorrow.id)).rejects.toThrow('Недостаточно стока')
    await createLot({
      country: 'Кения', name: 'Ньери', roastDate: '2025-10-06', degassingDays: 3, weightKg: 0.2904,
      allocations: [{ formatId: 'drip', purpose: '×16', weightKg: 0.2904 }],
    })
    const wrongLot = await draft(composition, 2)
    expect(wrongLot.preview.expected).toHaveLength(0)
    expect(await db.reservations.count()).toBe(0)
  })

  it('связывает ранние отчёты с частичными приходами и сохраняет обязательства в резервной копии', async () => {
    const { composition, task, employee } = await prepare()
    admin()
    const plan = await draft(composition, 2)
    await confirmAssemblyPlan(plan.id, undefined, plan.preview.approvalKey)
    await expect(writeOffProduction(task.id, 0.24, 'Проверка защищённого выпуска')).rejects.toThrow('не хватит')
    await reportAssembly(plan.task.id, employee.id, 1)
    const first = (await db.assemblyReports.toArray())[0]
    expect(first.deductions.map(({ quantity }) => quantity)).toEqual([4])
    expect(await db.expectedReservations.toArray()).toMatchObject([{ quantity: 8, reported: [{ reportId: first.id, quantity: 2 }] }])
    const backup = await exportBackup()
    await importBackup(backup)
    await produce(task.id, 5, employee.id)
    const firstReconciled = (await db.assemblyReports.get(first.id))!
    expect(firstReconciled.deductions.map(({ quantity }) => quantity)).toEqual([4, 2])
    const reconciledBatch = (await db.inventory.get(firstReconciled.deductions[1].inventoryLotId))!
    const receipt = (await db.productionEntries.get(reconciledBatch.productionEntryId!))!
    expect(receipt).toMatchObject({ taskId: task.id, quantity: 5 })
    expect(reconciledBatch).toMatchObject({ quantity: 3, reserved: 3 })
    expect(expectedOutput(await readAppSnapshot(), shiftDate).map(({ quantity }) => quantity)).toEqual([12])
    await reportAssembly(plan.task.id, employee.id, 1)
    await produce(task.id, 15, employee.id)
    const reports = await db.assemblyReports.toArray()
    expect(reports).toHaveLength(2)
    expect(reports.every((report) => report.deductions.reduce((sum, row) => sum + row.quantity, 0) === 6)).toBe(true)
    expect(await db.expectedReservations.count()).toBe(0)
    const stock = await db.inventory.toArray()
    expect(stock.reduce((sum, row) => sum + row.quantity, 0)).toBe(12)
    expect(stock.every(({ reserved }) => reserved === 0)).toBe(true)
  })

  it('исправляет ранний отчёт и при отмене освобождает только неиспользованный резерв', async () => {
    const { composition, task, employee } = await prepare()
    admin()
    const plan = await draft(composition, 2)
    await confirmAssemblyPlan(plan.id, undefined, plan.preview.approvalKey)
    await reportAssembly(plan.task.id, employee.id, 1)
    const report = (await db.assemblyReports.toArray())[0]
    await cancelAssemblyTask(plan.task.id, 'Остаток не нужен')
    expect(await db.expectedReservations.toArray()).toMatchObject([{ quantity: 2, reported: [{ reportId: report.id, quantity: 2 }] }])
    await correctAssemblyReport(report.id, 0, 'Сборка не выполнялась')
    expect(await db.expectedReservations.count()).toBe(0)
    await produce(task.id, 20, employee.id)
    const stock = await db.inventory.toArray()
    expect(stock.reduce((sum, row) => sum + row.quantity, 0)).toBe(24)
    expect(stock.every(({ reserved }) => reserved === 0)).toBe(true)
  })
})
