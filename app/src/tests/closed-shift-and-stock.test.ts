import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminSessionKey } from '@/domain/adminSession'
import { DEFAULT_SETTINGS, type ManualComposition } from '@/domain/types'
import { db, exportBackup, importBackup } from '@/persistence/db'
import { applyMoySkladSnapshot, updateMoySkladEntry } from '@/persistence/moySklad'
import { correctProductionEntry, ProductionCorrectionConflict } from '@/persistence/productionCorrection'
import { addEmployee, cancelAssemblyTask, closeProductionDay, confirmAssemblyPlan, correctAssemblyReport, createAssemblyPlan, createLot, produce, reportAssembly } from '@/persistence/repository'

const day = '2025-10-09'
const time = (hour: number) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`)
const testLot = async () => {
  const employee = await addEmployee('Анна', 'Лотова')
  const lot = await createLot({
    country: 'Эфиопия', name: 'Гуджи', roastDate: '2025-10-06', degassingDays: 3, weightKg: 0.484,
    allocations: [{ formatId: 'drip', purpose: '×16', weightKg: 0.484 }],
  })
  const task = (await db.productionTasks.where('lotId').equals(lot.id).first())!
  return { lot, employee, task }
}

function sumStock() {
  return db.inventory.toArray().then((rows) => rows.reduce((sum, { quantity }) => sum + quantity, 0))
}

function snapshot(lotId: string, quantity: number, hour: number) {
  return {
    id: `snapshot-${hour}`, startedAt: time(hour).toISOString(), fetchedAt: time(hour).toISOString(),
    rows: [{ lotId, formatId: 'drip', purpose: '×16', quantity }],
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(time(9))
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => key === adminSessionKey ? 'yes' : null })
  await db.transaction('rw', db.tables, async () => { for (const table of db.tables) await table.clear() })
  await db.settings.put(DEFAULT_SETTINGS)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('правка выпуска и сборки в закрытой смене', () => {
  it('откатывает конфликт 40 → 30 после списания 35 и связывает его с отчётом', async () => {
    const { lot, employee, task } = await testLot()
    await produce(task.id, 40, employee.id)
    const composition: ManualComposition = { id: 'limit', name: 'Гуджи', kind: 'limit', createdAt: time(9).toISOString(), enabled: true,
      items: [{ id: 'guji', country: lot.country, coffeeName: lot.name, inventoryLotId: lot.id, formatId: 'drip', quantityPerSet: 1 }] }
    await db.manualCompositions.put(composition)
    const plan = await createAssemblyPlan([{ composition, quantity: 35 }], day)
    const assembly = (await db.assemblyTasks.where('planId').equals(plan).first())!
    await confirmAssemblyPlan(plan)
    await reportAssembly(assembly.id, employee.id, 35)
    const report = (await db.assemblyReports.toArray())[0]
    const entry = (await db.productionEntries.toArray())[0]
    await closeProductionDay(day)
    vi.setSystemTime(new Date('2025-10-10T09:00:00Z'))
    const before = (await exportBackup()).data
    await expect(correctProductionEntry(entry.id, 30, 'Пересчёт')).rejects.toBeInstanceOf(ProductionCorrectionConflict)
    await expect(correctProductionEntry(entry.id, 30, 'Пересчёт')).rejects.toMatchObject({ taskIds: [assembly.id], reportIds: [report.id] })
    expect((await exportBackup()).data).toEqual(before)

    await correctAssemblyReport(report.id, 30, 'Собрали меньше')
    expect(await sumStock()).toBe(10)
    await cancelAssemblyTask(assembly.id, 'Остаток не переносим')
    await correctProductionEntry(entry.id, 30, 'Уточнён выпуск')
    expect(await sumStock()).toBe(0)
    const daily = (await db.dailyReports.toArray())[0]
    expect(daily.produced[0].quantity).toBe(30)
    expect(daily.assembled[0].fact).toBe(30)
    expect(await db.adjustments.toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: entry.id, previousValue: 40, newValue: 30, author: 'Администратор', reason: 'Уточнён выпуск' }),
      expect.objectContaining({ entityId: report.id, previousValue: 35, newValue: 30, author: 'Администратор' }),
    ]))
  })
})

describe('снимок остатков МоегоСклада', () => {
  it('применяет отметку только со свежим снимком и сохраняет локальное списание', async () => {
    const { lot, employee, task } = await testLot()
    await applyMoySkladSnapshot(snapshot(lot.id, 100, 9))
    vi.setSystemTime(time(10))
    await produce(task.id, 20, employee.id)
    expect(await sumStock()).toBe(120)
    const entry = (await db.productionEntries.toArray())[0]
    vi.setSystemTime(time(12))
    expect(await updateMoySkladEntry(entry.id, true, 'https://online.moysklad.ru/app/#operation')).toBe(true)

    await applyMoySkladSnapshot(snapshot(lot.id, 100, 11))
    expect(await sumStock()).toBe(120)
    await applyMoySkladSnapshot(snapshot(lot.id, 120, 13))
    expect(await sumStock()).toBe(120)
    expect(await db.productionEntries.get(entry.id)).toMatchObject({ moySkladApplied: true })
    const composition: ManualComposition = { id: 'x6', name: 'Гуджи', kind: 'x6', createdAt: time(9).toISOString(), enabled: true,
      items: [{ id: 'guji', country: lot.country, coffeeName: lot.name, inventoryLotId: lot.id, formatId: 'drip', quantityPerSet: 6 }] }
    await db.manualCompositions.put(composition)
    const plan = await createAssemblyPlan([{ composition, quantity: 1 }], day)
    const assembly = (await db.assemblyTasks.where('planId').equals(plan).first())!
    await confirmAssemblyPlan(plan)
    await reportAssembly(assembly.id, employee.id, 1)
    await applyMoySkladSnapshot(snapshot(lot.id, 120, 14))
    expect(await sumStock()).toBe(114)
    const good = await exportBackup()
    await expect(applyMoySkladSnapshot(snapshot(lot.id, 20, 15))).rejects.toThrow('не покрывает')
    expect((await exportBackup()).data).toEqual(good.data)
    await importBackup(good)
    expect(await sumStock()).toBe(114)
  })
})
