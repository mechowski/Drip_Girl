import { beforeEach, describe, expect, it } from 'vitest'
import { db, exportBackup, importBackup } from '@/persistence/db'
import { addEmployee, addManualComposition, confirmAssemblyPlan, correctAssemblyReport, createAssemblyPlan, createLot, produce, reportAssembly } from '@/persistence/repository'
import { DEFAULT_SETTINGS } from '@/domain/types'
import { uid } from '@/domain/calculations'

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => { for (const table of db.tables) await table.clear() })
  await db.settings.put({ ...DEFAULT_SETTINGS, nonWorkingDays: [], workingOverrides: [] })
})

describe('атомарный производственный контур', () => {
  it('сохраняет приход, резерв, два отчёта и FIFO без двойного списания', async () => {
    const first = await addEmployee('Анна', 'Иванова')
    const second = await addEmployee('Мария', 'Петрова')
    const names = ['A', 'B', 'C', 'D']
    for (const name of names) {
      const lot = await createLot({ country: 'Страна', name, roastDate: '2026-11-02', weightKg: 2.42, degassingDays: 3, allocations: [{ formatId: 'drip', purpose: '×16', weightKg: 2.42 }] })
      const task = await db.productionTasks.where('lotId').equals(lot.id).first()
      await produce(task!.id, 100, first.id)
    }
    expect(await db.inventory.count()).toBe(4)
    const items = names.map((name) => ({ id: uid(), country: 'Страна', coffeeName: name, formatId: 'drip' as const, quantityPerSet: 4 }))
    await addManualComposition('Тест ×16', 'limit', items)
    const composition = (await db.manualCompositions.toArray())[0]
    const planId = await createAssemblyPlan([{ composition, quantity: 5 }])
    await confirmAssemblyPlan(planId)
    expect((await db.inventory.toArray()).every((lot) => lot.reserved === 20)).toBe(true)
    const task = (await db.assemblyTasks.toArray())[0]
    await reportAssembly(task.id, first.id, 2, 'Первый отчёт')
    await expect(reportAssembly(task.id, second.id, 4)).rejects.toThrow('Осталось только 3')
    await reportAssembly(task.id, second.id, 3, 'Второй отчёт')
    expect((await db.inventory.toArray()).every((lot) => lot.quantity === 80 && lot.reserved === 0)).toBe(true)
    expect((await db.assemblyReports.toArray()).reduce((sum, report) => sum + report.quantity, 0)).toBe(5)
    expect((await db.reservations.toArray()).every((reservation) => reservation.status === 'completed')).toBe(true)
    expect((await db.assemblyTasks.get(task.id))?.status).toBe('completed')
    const latest = (await db.assemblyReports.toArray()).find((report) => report.employeeId === second.id)!
    await correctAssemblyReport(latest.id, 2, 'Один набор отмечен ошибочно')
    expect((await db.inventory.toArray()).every((lot) => lot.quantity === 84 && lot.reserved === 4)).toBe(true)
    expect((await db.assemblyReports.get(latest.id))?.previousQuantity).toBe(3)
    expect((await db.assemblyTasks.get(task.id))?.status).toBe('partial')
  })

  it('откатывает весь план при нехватке одного лота', async () => {
    const employee = await addEmployee('Анна', 'Иванова')
    for (const name of ['A', 'B']) {
      const lot = await createLot({ country: 'Страна', name, roastDate: '2026-11-02', weightKg: 1.21, degassingDays: 3, allocations: [{ formatId: 'drip', purpose: '×16', weightKg: 1.21 }] })
      const task = await db.productionTasks.where('lotId').equals(lot.id).first()
      await produce(task!.id, name === 'A' ? 100 : 4, employee.id)
    }
    const composition = { id: 'manual', name: 'Два лота', kind: 'limit' as const, enabled: true, createdAt: new Date().toISOString(), items: ['A', 'B'].map((name) => ({ id: name, country: 'Страна', coffeeName: name, formatId: 'drip' as const, quantityPerSet: 4 })) }
    const planId = await createAssemblyPlan([{ composition, quantity: 2 }])
    await expect(confirmAssemblyPlan(planId)).rejects.toThrow('Недостаточно стока')
    expect((await db.inventory.toArray()).every((lot) => lot.reserved === 0)).toBe(true)
    expect(await db.reservations.count()).toBe(0)
  })

  it('экспортирует и восстанавливает историю без потерь', async () => {
    await addEmployee('Анна', 'Иванова')
    const backup = await exportBackup()
    expect(backup.schemaVersion).toBe(2)
    await db.employees.clear()
    await importBackup(backup)
    expect(await db.employees.count()).toBe(1)
    await expect(importBackup({ schemaVersion: 99, exportedAt: 'x', data: {} })).rejects.toThrow('более новой')
  })
})
