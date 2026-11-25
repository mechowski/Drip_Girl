import { addDays, format } from 'date-fns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminSessionKey } from '@/domain/adminSession'
import { assemblyByComposition } from '@/domain/shiftReport'
import { assemblyDripShares } from '@/domain/assemblyReports'
import { allocateStock, compositionCapacity, matchDemands, taskDemands } from '@/domain/calculations'
import { DEFAULT_SETTINGS, type CompositionItem, type InventoryLot, type ImportedComposition, type ManualComposition } from '@/domain/types'
import { db, exportBackup, importBackup } from '@/persistence/db'
import { addEmployee, adjustInventory, cancelAssemblyTask, closeProductionDay, confirmAssemblyPlan, correctAssemblyReport, createAssemblyPlan, reassignInventory, reportAssembly } from '@/persistence/repository'

const date = '2026-11-18T10:00:00.000Z'
const item = (id = 'a', overrides: Partial<CompositionItem> = {}): CompositionItem => ({ id, country: 'Эфиопия', coffeeName: 'Гуджи', formatId: 'drip', quantityPerSet: 6, ...overrides })
const stock = (id: string, quantity: number, overrides: Partial<InventoryLot> = {}): InventoryLot => ({
  id, sourceLotId: id, productionTaskId: 'manufacture', country: 'Эфиопия', coffeeName: 'Гуджи', formatId: 'drip', purpose: '×6', quantity, reserved: 0,
  manufacturedAt: date, createdAt: date, inBU: false, ...overrides,
})
const composition: ManualComposition = { id: 'composition', name: 'Гуджи ×6', kind: 'x6', enabled: true, createdAt: date, items: [item()] }

async function draft(quantity: number) {
  await db.manualCompositions.put(composition)
  const id = await createAssemblyPlan([{ composition, quantity }])
  const tasks = await db.assemblyTasks.where('planId').equals(id).toArray()
  return { id, tasks, task: tasks[0] }
}

async function preview(tasks: Awaited<ReturnType<typeof draft>>['tasks']) {
  return allocateStock(taskDemands(tasks), await db.inventory.toArray())
}

describe('распределение стока по составам', () => {
  it('суммирует расход совпадающих позиций и учитывает общий объём черновика', () => {
    const inventory = [stock('old', 17), stock('new', 10, { reserved: 2 })]
    const items = [item('a', { quantityPerSet: 4 }), item('b', { quantityPerSet: 4 })]
    expect(compositionCapacity(items, inventory).maximum).toBe(3)
    expect(compositionCapacity(items, inventory, matchDemands([item()], 1)).maximum).toBe(2)
  })

  it('учитывает покрытую часть дефицитной строки и оставляет независимый сток доступным', () => {
    const independent = { coffeeName: 'Уила' }
    const inventory = [stock('guji', 8), stock('huila', 24, independent)]
    const otherDemands = matchDemands([item()], 2)
    expect(compositionCapacity([item('shared')], inventory, otherDemands).maximum).toBe(0)
    expect(compositionCapacity([item('independent', independent)], inventory, otherDemands).maximum).toBe(4)
  })

  it('различает форматы даже при явном сопоставлении, а СМОЛ исключает из сборки', () => {
    const inventory = [stock('m', 18, { sourceLotId: 'lot', formatId: 'mega', purpose: 'Мега' }), stock('d', 12, { sourceLotId: 'lot' })]
    const selected = item('selected', { inventoryLotId: 'lot', formatId: 'mega' })
    expect(compositionCapacity([selected], inventory).maximum).toBe(3)
    expect(compositionCapacity([selected], [inventory[1]]).valid).toBe(false)
    expect(compositionCapacity([item('small', { formatId: 'smol30' })], [stock('s', 100, { formatId: 'smol30' })]).valid).toBe(false)
  })

  it('объединяет одноимённые партии и не путает два неоднозначных написания', () => {
    const inventory = [stock('a', 6, { country: 'Йемен', coffeeName: 'Сёё' }), stock('b', 6, { country: ' йемен ', coffeeName: 'СЁЁ' }), stock('c', 6, { country: 'Йемен', coffeeName: 'Сее' })]
    expect(compositionCapacity([item('test', { country: 'Йемен', coffeeName: 'Сёё' })], inventory).maximum).toBe(2)
    expect(compositionCapacity([item('test', { country: 'Йемен', coffeeName: 'Сёе' })], inventory).valid).toBe(false)
  })

  it('оставляет сток с явным источником для узкой позиции и применяет FIFO внутри доступного назначения', () => {
    const inventory = [stock('older', 6), stock('middle', 6, { createdAt: '2026-11-18T10:01:00.000Z' }), stock('latest', 6, { createdAt: '2026-11-18T10:02:00.000Z' })]
    const selected = item('spec', { inventoryLotId: 'older' })
    const shared = item('shared')
    const allocation = allocateStock(matchDemands([shared, selected], 1, 'x6'), inventory)
    expect(allocation.shortages).toHaveLength(0)
    expect(allocation.allocations.map(({ demand, lot }) => [demand.item.id, lot.id])).toEqual([['spec', 'older'], ['shared', 'middle']])
    expect(compositionCapacity([selected], inventory, matchDemands([shared], 2, 'x6'), 'x6').maximum).toBe(1)
  })
})

function approveAsAdmin() {
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => key === adminSessionKey ? 'yes' : null })
}

describe('операции стока и смены', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(async () => {
    await db.transaction('rw', db.tables, async () => { for (const table of db.tables) await table.clear() })
    await db.settings.put({ ...DEFAULT_SETTINGS, nonWorkingDays: [], workingOverrides: [] })
  })

  it('требует подтверждения актуального переназначения и сохраняет историю обеих партий', async () => {
    await db.inventory.add(stock('stock', 20, { purpose: '×16' }))
    const { id, tasks } = await draft(1)
    const original = await preview(tasks)
    expect(original.moves[0].quantity).toBe(6)
    await expect(confirmAssemblyPlan(id)).rejects.toThrow('подтвердите использование')
    expect(await db.reservations.count()).toBe(0)
    await reassignInventory('stock', '×6', 2)
    await expect(confirmAssemblyPlan(id, original.approvalKey)).rejects.toThrow('подтвердите использование')
    const current = await preview(tasks)
    expect(current.moves[0].quantity).toBe(4)
    await confirmAssemblyPlan(id, current.approvalKey)
    const inventory = await db.inventory.toArray()
    expect(inventory.reduce((total, row) => total + row.quantity, 0)).toBe(20)
    expect(inventory.reduce((total, row) => total + row.reserved, 0)).toBe(6)
    expect(inventory.filter((row) => row.reserved).every(({ purpose }) => purpose === '×6')).toBe(true)
    const events = (await db.inventoryTransactions.toArray()).filter(({ type }) => type === 'reassign')
    expect(events.map(({ quantity }) => quantity).sort((a, b) => a - b)).toEqual([-4, -2, 2, 4])
    expect(events.every((row) => row.previousQuantity + row.quantity === row.newQuantity && row.relatedInventoryLotId)).toBe(true)
  })

  it('не резервирует сток дважды при параллельном подтверждении', async () => {
    await db.inventory.add(stock('stock', 6))
    const first = await draft(1)
    const second = await draft(1)
    const outcomes = await Promise.allSettled([confirmAssemblyPlan(first.id), confirmAssemblyPlan(second.id)])
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect((await db.inventory.get('stock'))?.reserved).toBe(6)
    expect(await db.reservations.count()).toBe(1)
    expect(await db.warnings.filter(({ type }) => type === 'shortage').count()).toBe(1)
    await expect(adjustInventory('stock', -1, 'Ошибка')).rejects.toThrow('неотрицательное')
    await expect(adjustInventory('stock', 5, 'Ошибка')).rejects.toThrow('меньше активного резерва')
    await adjustInventory('stock', 8, 'Найден излишек')
    await expect(adjustInventory('stock', 7, 'Устаревшая форма', '', 6)).rejects.toThrow('Остаток изменился')
    await adjustInventory('stock', 7, 'Списание брака', '', 8, 'writeoff')
    expect((await db.inventory.get('stock'))).toMatchObject({ quantity: 7, reserved: 6 })
    expect((await db.inventoryTransactions.toArray()).find(({ type }) => type === 'writeoff')).toMatchObject({ previousQuantity: 8, newQuantity: 7 })
  })

  it('принимает один совместный отчёт и делит 80 дрипов на двух сборщиков', async () => {
    const first = await addEmployee('Анна', 'Иванова')
    const second = await addEmployee('Мария', 'Петрова')
    const items = ['Первый', 'Второй', 'Третий', 'Четвёртый'].map((coffeeName) => item(coffeeName, { coffeeName, quantityPerSet: 4 }))
    const recipe: ImportedComposition = {
      kind: 'x16', id: 'x16', name: 'Дегустация', sheetConnectionId: 'sheet', sheetName: '×16', column: 1,
      items, enabled: true, importedAt: date, metadata: {},
    }
    await db.importedCompositions.add(recipe)
    await db.inventory.bulkAdd(items.map(({ id, coffeeName }) => stock(id, 24, { coffeeName, purpose: '×16' })))
    const id = await createAssemblyPlan([{ composition: recipe, quantity: 6, jointAssembly: true }])
    const task = (await db.assemblyTasks.where('planId').equals(id).first())!
    await confirmAssemblyPlan(id)
    await expect(reportAssembly(task.id, first.id, 5)).rejects.toThrow('двух разных участников')
    await expect(reportAssembly(task.id, [first.id, first.id], 5)).rejects.toThrow('двух разных участников')
    const participants = [first.id, second.id]
    await reportAssembly(task.id, participants, 5)
    await expect(reportAssembly(task.id, participants, 1)).rejects.toThrow('уже отправлен')
    const reports = await db.assemblyReports.toArray()
    expect(reports).toHaveLength(1)
    const [report] = reports
    expect(report).toMatchObject({ quantity: 5, originalQuantity: 5, participantIds: participants })
    expect(report.deductions.reduce((sum, row) => sum + row.quantity, 0)).toBe(80)
    expect(assemblyDripShares(task, report)).toEqual(participants.map((employeeId) => ({ employeeId, quantity: 40 })))
    expect((await db.inventory.toArray()).every(({ quantity, reserved }) => quantity === 4 && reserved === 4)).toBe(true)
    approveAsAdmin()
    await correctAssemblyReport(report.id, 4, 'Уточнили количество')
    expect(await db.assemblyReports.get(report.id)).toMatchObject({ quantity: 4, originalQuantity: 5, participantIds: participants })
  })

  it('списывает FIFO из нескольких выпусков, переносит остаток и исправляет архив без возврата отменённого резерва', async () => {
    const first = await addEmployee('Анна', 'Иванова')
    const second = await addEmployee('Мария', 'Петрова')
    await db.inventory.bulkAdd([stock('old', 4), stock('new', 20, { manufacturedAt: '2026-11-18T10:01:00.000Z' })])
    const { id, task } = await draft(3)
    await confirmAssemblyPlan(id)
    await reportAssembly(task.id, first.id, 1)
    const initial = (await db.assemblyReports.toArray())[0]
    expect(initial.deductions.map(({ inventoryLotId, quantity }) => [inventoryLotId, quantity])).toEqual([['old', 4], ['new', 2]])
    await reportAssembly(task.id, second.id, 1)
    await expect(reportAssembly(task.id, first.id, 2)).rejects.toThrow('Осталось только 1')
    const today = format(new Date(), 'yyyy-MM-dd')
    approveAsAdmin()
    await closeProductionDay(today, [{ taskId: task.id, completedQuantity: 2, transfer: true }])
    const daily = await db.dailyReports.where('date').equals(today).first()
    expect(daily?.assembled[0]).toMatchObject({ fact: 2, remaining: 1, disposition: 'transferred' })
    expect(daily?.assembled[0]).not.toHaveProperty('employees')
    expect((await db.assemblyTasks.get(task.id))?.status).toBe('transferred')
    expect((await db.inventory.get('new'))?.reserved).toBe(6)
    await expect(reportAssembly(task.id, first.id, 1)).rejects.toThrow()
    await cancelAssemblyTask(task.id, 'Заказ отменён')
    await correctAssemblyReport(initial.id, 0, 'Первый отчёт отправлен по ошибке')
    expect((await db.inventory.get('old'))).toMatchObject({ quantity: 4, reserved: 0 })
    expect((await db.inventory.get('new'))).toMatchObject({ quantity: 14, reserved: 0 })
    expect((await db.assemblyReports.get(initial.id))).toMatchObject({ quantity: 0, previousQuantity: 1, deductions: [] })
    expect((await db.assemblyTasks.get(task.id))?.status).toBe('cancelled')
    expect((await db.dailyReports.get(daily!.id))?.assembled[0]).toMatchObject({ fact: 1, remaining: 2 })
  })

  it('закрывает смену атомарно, учитывает явный ноль и сохраняет выбор по каждому остатку', async () => {
    const employee = await addEmployee('Анна', 'Иванова')
    const second = await addEmployee('Мария', 'Петрова')
    await db.inventory.add(stock('stock', 60))
    await db.manualCompositions.put(composition)
    const otherRecipe = { ...composition, id: 'second-recipe', name: 'Другой состав' }
    await db.manualCompositions.put(otherRecipe)
    const transfer = await draft(4)
    const releasePlan = await createAssemblyPlan([{ composition: otherRecipe, quantity: 4, jointAssembly: true }])
    const release = (await db.assemblyTasks.where('planId').equals(releasePlan).first())!
    const zero = await draft(1)
    for (const id of [transfer.id, releasePlan, zero.id]) await confirmAssemblyPlan(id)
    await reportAssembly(transfer.task.id, employee.id, 3)
    const day = format(new Date(), 'yyyy-MM-dd')
    const decisions = [
      { taskId: transfer.task.id, completedQuantity: 3, transfer: true },
      { taskId: release.id, completedQuantity: 0, transfer: false, fact: { quantity: 3, participantIds: [employee.id, second.id] } },
      { taskId: zero.task.id, completedQuantity: 0, transfer: false, fact: { quantity: 0, participantIds: [] } },
    ]
    await expect(closeProductionDay(day, decisions)).rejects.toThrow('только администратор')
    approveAsAdmin()
    const withoutZero = [...decisions.slice(0, 2), { taskId: zero.task.id, completedQuantity: 0, transfer: false }]
    await expect(closeProductionDay(day, withoutZero)).rejects.toThrow('Укажите факт')
    expect(await db.assemblyReports.count()).toBe(1)
    expect(await db.dailyReports.count()).toBe(0)
    expect(await db.inventory.get('stock')).toMatchObject({ quantity: 42, reserved: 36 })

    await closeProductionDay(day, decisions)
    expect(await db.inventory.get('stock')).toMatchObject({ quantity: 24, reserved: 6 })
    expect(await db.assemblyTasks.get(transfer.task.id)).toMatchObject({ completedQuantity: 3, status: 'transferred' })
    expect(await db.assemblyTasks.get(release.id)).toMatchObject({ completedQuantity: 3, status: 'cancelled' })
    expect(await db.assemblyTasks.get(zero.task.id)).toMatchObject({ completedQuantity: 0, status: 'cancelled' })
    const reports = await db.assemblyReports.toArray()
    expect(reports).toContainEqual(expect.objectContaining({ taskId: release.id, quantity: 3, recordedBy: 'administrator', participantIds: [employee.id, second.id] }))
    expect(reports).toContainEqual(expect.objectContaining({ taskId: zero.task.id, quantity: 0, recordedBy: 'administrator', participantIds: [], deductions: [] }))
    const daily = (await db.dailyReports.toArray())[0]
    expect(daily.assembled).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: transfer.task.id, plan: 4, fact: 3, remaining: 1, disposition: 'transferred' }),
      expect.objectContaining({ taskId: release.id, plan: 4, fact: 3, remaining: 1, disposition: 'released' }),
    ]))
    const totals = assemblyByComposition(daily.assembled, await db.assemblyTasks.toArray())
    expect(totals).toHaveLength(2)
    expect(totals).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: composition.name, fact: 3, plan: 5, remaining: 1 }),
      expect.objectContaining({ name: otherRecipe.name, fact: 3, plan: 4, remaining: 0 }),
    ]))
    const backup = await exportBackup()
    await importBackup(backup)
    expect(await db.assemblyReports.count()).toBe(3)
  })

  it('не подтверждает отключённый состав и сохраняет снимок запущенного задания', async () => {
    await db.inventory.add(stock('stock', 24))
    const { id, task } = await draft(1)
    await db.manualCompositions.update(composition.id, { enabled: false })
    await expect(confirmAssemblyPlan(id)).rejects.toThrow('изменился или отключён')
    await db.manualCompositions.update(composition.id, { enabled: true })
    await confirmAssemblyPlan(id)
    await db.manualCompositions.update(composition.id, { name: 'Новое название', items: [item('new', { quantityPerSet: 5 })] })
    expect(await db.assemblyTasks.get(task.id)).toMatchObject({ name: composition.name, compositionSnapshot: composition.items })
  })

  it('возвращает исправленную завершённую задачу в открытую смену', async () => {
    const employee = await addEmployee('Анна', 'Иванова')
    const current = new Date()
    const today = format(current, 'yyyy-MM-dd')
    const yesterday = format(addDays(current, -1), 'yyyy-MM-dd')
    await db.settings.update('settings', { workingOverrides: [today] })
    await db.inventory.add(stock('stock', 12))
    const { id, task } = await draft(1)
    await confirmAssemblyPlan(id)
    await reportAssembly(task.id, employee.id, 1)
    const original = (await db.assemblyReports.toArray())[0]
    await db.assemblyTasks.update(task.id, { productionDate: yesterday })
    await db.assemblyReports.update(original.id, { productionDate: yesterday })
    approveAsAdmin()
    await closeProductionDay(yesterday)
    await correctAssemblyReport(original.id, 0, 'Исправление закрытой смены')
    expect(await db.assemblyTasks.get(task.id)).toMatchObject({ status: 'confirmed', productionDate: today })
    expect(await db.inventory.get('stock')).toMatchObject({ quantity: 12, reserved: 6 })
    await reportAssembly(task.id, employee.id, 1)
    expect(await db.inventory.get('stock')).toMatchObject({ quantity: 6, reserved: 0 })
  })
})
