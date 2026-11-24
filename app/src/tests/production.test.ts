import { beforeEach, describe, expect, it } from 'vitest'
import { allocateStock, remainingCoffee } from '@/domain/calculations'
import { DEFAULT_SETTINGS } from '@/domain/types'
import { db, exportBackup, importBackup } from '@/persistence/db'
import { addEmployee, approveSchedule, createLot, deleteLot, getSettings, markBU, produce, updateLot, updateLotDegassing, updateProductionCalendar, updateSettings, writeOffProduction } from '@/persistence/repository'

const baseline = {
  country: 'Колумбия',
  name: 'Эль Параисо',
  roastDate: '2025-10-06',
  weightKg: 0.242,
  degassingDays: 3,
  allocations: [{ formatId: 'drip' as const, purpose: '×16', weightKg: 0.242 }],
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear()
    await db.settings.put(DEFAULT_SETTINGS)
  })
})

describe('изготовление и история', () => {
  it('расход каждой операции хранится с фактическим коэффициентом', async () => {
    const employee = await addEmployee('Анна', 'Громова')
    const lot = await createLot(baseline)
    const initial = (await db.productionTasks.where('lotId').equals(lot.id).first())!
    await produce(initial.id, 4, employee.id)
    const updated = DEFAULT_SETTINGS.formats.map((item) => item.id === 'drip' ? { ...item, coefficient: 0.02 } : item)
    await updateSettings({ formats: updated })
    const result = await produce(initial.id, 2, employee.id)
    expect(result.task.plannedQuantity).toBe(20)
    expect(result.remainder).toBeCloseTo(0.1536)
    const entries = (await db.productionEntries.toArray()).sort((a, b) => a.coefficientSnapshot - b.coefficientSnapshot)
    expect(entries.map(({ coefficientSnapshot }) => coefficientSnapshot)).toEqual([0.0121, 0.02])
    await expect(writeOffProduction(initial.id, 0.154, 'Списание')).rejects.toThrow('больше расчётного')
    await writeOffProduction(initial.id, 0.1536, 'Технологический остаток')
    const finished = (await db.productionTasks.get(initial.id))!
    expect(finished.status).toBe('completed')
    expect(remainingCoffee(finished, updated[0], entries)).toBeCloseTo(0)
    expect(await db.adjustments.toArray()).toMatchObject([{ entityType: 'production', previousValue: expect.closeTo(0.1536), newValue: expect.closeTo(0) }])
  })

  it('помнит исходное назначение раннего выпуска после изменения остатков', async () => {
    const employee = await addEmployee('Анна', 'Громова')
    const lot = await createLot({
      ...baseline,
      allocations: [
        { formatId: 'drip', purpose: '×16', weightKg: 0.0242 },
        { formatId: 'drip', purpose: '×6', weightKg: 0.2178 },
      ],
    })
    const tasks = await db.productionTasks.where('lotId').equals(lot.id).toArray()
    const task = tasks.find(({ purpose }) => purpose === '×16')!
    await db.productionTasks.bulkDelete(tasks.filter(({ id }) => id !== task.id).map(({ id }) => id))
    await db.productionTasks.update(task.id, { purpose: undefined, sourceWeightKg: 0.242, plannedQuantity: 20 })
    const early = await produce(task.id, 2, employee.id)
    expect(early.received).toBe(2)
    const firstStock = (await db.inventory.where('sourceLotId').equals(lot.id).first())!
    expect(firstStock.purpose).toBe('×16')
    await db.inventory.update(firstStock.id, { quantity: 0 })
    const final = await produce(task.id, 18, employee.id)
    expect(final.task.status).toBe('completed')
    const newReceipts = (await db.inventory.where('sourceLotId').equals(lot.id).toArray()).filter(({ id }) => id !== firstStock.id)
    expect(newReceipts).toMatchObject([{ purpose: '×6', quantity: 18 }])
  })

  it('выпускает три назначения отдельно и использует обычный сток совместно без СТМ', async () => {
    const employee = await addEmployee('Анна', 'Громова')
    const lot = await createLot({
      ...baseline, weightKg: 25,
      allocations: [
        { formatId: 'drip', purpose: '×16', weightKg: 12.5 },
        { formatId: 'drip', purpose: '×30', weightKg: 6 },
        { formatId: 'drip', purpose: 'СТМ', weightKg: 6.5 },
      ],
    })
    const tasks = await db.productionTasks.where('lotId').equals(lot.id).toArray()
    expect(tasks).toHaveLength(3)
    expect(Object.fromEntries(tasks.map((task) => [task.purpose, task.sourceWeightKg]))).toEqual({ '×16': 12.5, '×30': 6, СТМ: 6.5 })
    for (const task of tasks) {
      await produce(task.id, task.plannedQuantity, employee.id)
    }
    const inventory = await db.inventory.toArray()
    const common = inventory.filter((item) => item.purpose !== 'СТМ').reduce((sum, item) => sum + item.quantity, 0)
    const item = { id: 'composition-item', country: lot.country, coffeeName: lot.name, formatId: 'drip' as const, quantityPerSet: 1 }
    const result = allocateStock([{ item, quantity: common + 1, purpose: '×16' }], inventory)
    expect(result.moves).toHaveLength(0)
    expect(result.shortages).toMatchObject([{ quantity: 1, reason: 'shortage' }])
    expect(new Set(result.allocations.map(({ lot }) => lot.purpose))).toEqual(new Set(['×16', '×30']))
  })

  it('разделяет ожидающую задачу при восстановлении старой базы', async () => {
    const lot = await createLot({ ...baseline, allocations: [
      { formatId: 'drip', purpose: '×16', weightKg: 0.121 },
      { formatId: 'drip', purpose: 'СТМ', weightKg: 0.121 },
    ] })
    const backup = await exportBackup()
    const first = (await db.productionTasks.where('lotId').equals(lot.id).first())!
    backup.schemaVersion = 4
    backup.data.productionTasks = [{ ...first, purpose: undefined, sourceWeightKg: 0.242, plannedQuantity: 20 }]
    await importBackup(backup)
    const tasks = await db.productionTasks.where('lotId').equals(lot.id).toArray()
    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: '×16', sourceWeightKg: 0.121, plannedQuantity: 10 }),
      expect.objectContaining({ purpose: 'СТМ', sourceWeightKg: 0.121, plannedQuantity: 10 }),
    ]))
    expect(tasks).toHaveLength(2)
  })

  it('сохраняет реальный выпуск при превышении расчётного веса и показывает расхождение', async () => {
    const employee = await addEmployee('Анна', 'Громова')
    const lot = await createLot(baseline)
    const task = (await db.productionTasks.where('lotId').equals(lot.id).first())!
    const result = await produce(task.id, 25, employee.id)
    expect(result.received).toBe(25)
    expect(result.remainder).toBe(0)
    expect(await db.warnings.where('type').equals('discrepancy').count()).toBe(1)
  })
})

describe('сроки производственных задач', () => {
  it('пересчитывает готовность при изменении срока и применяет ручные дни', async () => {
    const lot = await createLot(baseline)
    const allocation = (await db.allocations.where('lotId').equals(lot.id).first())!
    await updateLotDegassing(lot.id, 3, { [allocation.id]: 5 })
    const task = (await db.productionTasks.where('lotId').equals(lot.id).first())!
    expect(task).toMatchObject({ readyDate: '2025-10-11', plannedDate: '2025-10-13', buDate: '2025-10-10', approved: false })
    await updateProductionCalendar({ day: '2025-10-11', mode: 'working' })
    const changed = (await db.productionTasks.get(task.id))!
    expect(changed).toMatchObject({ readyDate: '2025-10-11', plannedDate: '2025-10-11', scheduleDecision: 'none', approved: true })
    expect(changed.buDate).toBeUndefined()
    expect((await db.warnings.toArray()).some((warning) => warning.type === 'bu' && warning.read)).toBe(true)
    await updateProductionCalendar({ nonWorkingDays: ['2025-10-10'], workingDays: [] })
    expect((await getSettings()).workingOverrides).toContain('2025-10-11')
    await updateProductionCalendar({ day: '2025-10-11', mode: 'default' })
    expect(await db.productionTasks.get(task.id)).toMatchObject({ plannedDate: '2025-10-13', buDate: '2025-10-09', approved: false })
  })

  it('для Б/у отдельно подтверждает упаковку и принимает на сток только выпуск', async () => {
    const employee = await addEmployee('Анна', 'Громова')
    const lot = await createLot({ ...baseline, degassingDays: 5 })
    const task = (await db.productionTasks.where('lotId').equals(lot.id).first())!
    await expect(markBU(task.id)).rejects.toThrow('подтвердите')
    await approveSchedule(task.id)
    await expect(produce(task.id, 10, employee.id)).rejects.toThrow('запакован')
    await markBU(task.id)
    expect(await db.inventory.count()).toBe(0)
    expect(await db.productionTasks.get(task.id)).toMatchObject({ inBU: true, plannedDate: '2025-10-13' })
    await updateProductionCalendar({ day: '2025-10-13', mode: 'closed' })
    expect(await db.productionTasks.get(task.id)).toMatchObject({ inBU: true, buDate: '2025-10-10', plannedDate: '2025-10-14', approved: false })
    await approveSchedule(task.id)
    await produce(task.id, 10, employee.id)
    expect(await db.inventory.toArray()).toMatchObject([{ quantity: 10, inBU: true }])
  })

  it('проверяет любой индивидуальный срок и дату', async () => {
    await expect(createLot({ ...baseline, roastDate: '2025-02-29' })).rejects.toThrow('корректную дату')
    await expect(createLot({ ...baseline, allocations: [{ ...baseline.allocations[0], degassingDays: 0 }] })).rejects.toThrow('1 до 5')
    expect(await db.productionTasks.count()).toBe(0)
  })
})

describe('исправление и удаление лота', () => {
  it('обновляет задачи по назначениям и удаляет лот до начала работы', async () => {
    const lot = await createLot(baseline)
    const initialTask = (await db.productionTasks.where('lotId').equals(lot.id).first())!
    const changed = { ...baseline, name: 'Исправленный лот', weightKg: 0.484, allocations: [
      { ...baseline.allocations[0], weightKg: 0.242 },
      { formatId: 'mega' as const, purpose: 'Мега', weightKg: 0.242 },
    ] }
    await updateLot(lot.id, changed)
    expect(await db.lots.get(lot.id)).toMatchObject({ name: changed.name, weightKg: 0.484 })
    const tasks = await db.productionTasks.where('lotId').equals(lot.id).toArray()
    expect(tasks).toHaveLength(2)
    expect(tasks.find(({ formatId }) => formatId === 'drip')?.id).toBe(initialTask.id)
    await deleteLot(lot.id)
    expect(await db.lots.get(lot.id)).toBeUndefined()
    expect(await db.productionTasks.where('lotId').equals(lot.id).count()).toBe(0)
    expect(await db.allocations.where('lotId').equals(lot.id).count()).toBe(0)
  })

  it('защищает выпуск при удалении и меняет название на стоке при исправлении', async () => {
    const employee = await addEmployee('Анна', 'Громова')
    const lot = await createLot(baseline)
    const task = (await db.productionTasks.where('lotId').equals(lot.id).first())!
    await produce(task.id, 4, employee.id)
    await expect(deleteLot(lot.id)).rejects.toThrow('на стоке')
    await expect(updateLot(lot.id, baseline)).rejects.toThrow('После начала производства')
    await updateLot(lot.id, { country: lot.country, name: 'Правильное название', comment: 'Уточнено' })
    expect(await db.inventory.where('sourceLotId').equals(lot.id).first()).toMatchObject({ coffeeName: 'Правильное название', quantity: 4 })
    expect(await db.productionEntries.filter((entry) => entry.lotId === lot.id).count()).toBe(1)
  })
})
