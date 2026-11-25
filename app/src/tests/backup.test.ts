import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { db, exportBackup, importBackup, tableNames, validateBackup } from '@/persistence/db'
import { addEmployee, clearDemoData, createLot, seedDemoData } from '@/persistence/repository'
import { DEFAULT_SETTINGS, SCHEMA_VERSION, type CoffeeLot, type ProductionTask } from '@/domain/types'

const stamp = '2026-01-07T14:00:00.000Z'
const legacyLot: CoffeeLot = {
  id: 'lot', country: 'Кения', name: 'Тест', roastDate: '2026-01-02',
  weightKg: 1, degassingDays: 4, createdAt: stamp,
}
const legacyTask: ProductionTask = {
  id: 'task', lotId: legacyLot.id, formatId: 'drip', sourceWeightKg: 1, plannedQuantity: 82, producedQuantity: 0,
  writtenOffKg: 0, readyDate: '2026-01-06', plannedDate: '2026-01-01', actualDegassingDays: -1,
  scheduleDecision: 'bu', approved: true, inBU: false, status: 'open', createdAt: stamp,
}

afterEach(async () => {
  db.close()
  await Dexie.delete(db.name)
})

describe('резервная копия IndexedDB', () => {
  it('проверяет поля, полноту и резервы до записи', async () => {
    await db.open()
    await addEmployee('Анна', 'Иванова')
    const original = await exportBackup()
    expect(validateBackup(original)).toEqual(original)

    const missing = structuredClone(original)
    delete missing.data.auditEvents
    await expect(importBackup(missing)).rejects.toThrow('отсутствуют таблицы')

    const invalid = structuredClone(original)
    invalid.data.employees = [{ ...(original.data.employees[0] as object), active: 'true' }]
    await expect(importBackup(invalid)).rejects.toThrow('active')

    const mismatch = structuredClone(original)
    mismatch.data.inventory.push({
      id: 'stock', sourceLotId: 'lot', country: 'Кения', coffeeName: 'Тест', formatId: 'drip',
      purpose: '×16', quantity: 10, reserved: 5, manufacturedAt: stamp, createdAt: stamp, inBU: false,
    })
    await expect(importBackup(mismatch)).rejects.toThrow('не сходится резерв')
    expect((await exportBackup()).data).toEqual(original.data)
  })

  it('восстанавливает схему 2, отдельную дату Б/у и историю', async () => {
    await db.open()
    const data: Record<string, unknown[]> = Object.fromEntries(tableNames.map((name) => [name, []]))
    delete data.expectedReservations
    data.lots = [legacyLot]
    data.productionTasks = [legacyTask]
    data.settings = [{ ...DEFAULT_SETTINGS, theme: 'dark', schemaVersion: 2 }]
    data.auditEvents = [{ id: 'old-audit', action: 'create', entityId: legacyLot.id, entityType: 'lot', description: 'Создан лот', createdAt: stamp }]
    await importBackup({ schemaVersion: 2, exportedAt: stamp, data })
    expect(await db.settings.get('settings')).toMatchObject({ theme: 'dark', schemaVersion: SCHEMA_VERSION })
    expect(await db.productionTasks.get(legacyTask.id)).toMatchObject({ buDate: legacyTask.plannedDate, plannedDate: '2026-01-12', actualDegassingDays: 10 })
    expect(await db.auditEvents.toArray()).toEqual(data.auditEvents)
    expect(await db.expectedReservations.count()).toBe(0)
  })

  it('обновляет существующую базу Dexie со схемы 2', async () => {
    const old = new Dexie(db.name)
    old.version(2).stores({
      lots: 'id, country, roastDate', productionTasks: 'id, lotId, status, plannedDate',
      inventory: 'id, sourceLotId, productionTaskId, formatId, purpose, manufacturedAt', settings: 'id',
    })
    await old.open()
    try {
      await old.table('settings').add({ ...DEFAULT_SETTINGS, theme: 'dark', schemaVersion: 2 })
      await old.table('lots').add(legacyLot)
      await old.table('productionTasks').add(legacyTask)
    } finally { old.close() }
    await db.open()
    expect(db.verno).toBe(SCHEMA_VERSION)
    expect(await db.settings.get('settings')).toMatchObject({ theme: 'dark', schemaVersion: SCHEMA_VERSION })
    expect(await db.productionTasks.get(legacyTask.id)).toMatchObject({ buDate: legacyTask.plannedDate, plannedDate: '2026-01-12' })
  })

  it('сохраняет рабочие связи при очистке демо и разрешает очистить независимые записи', async () => {
    await db.open()
    const real = await addEmployee('Анна', 'Иванова')
    await seedDemoData()
    expect(await db.employees.count()).toBe(3)
    await clearDemoData()
    expect(await db.employees.toArray()).toEqual([real])
    expect(await db.lots.count()).toBe(0)
    await seedDemoData()
    const demo = (await db.employees.toArray()).find((person) => person.isDemo)!
    await createLot({
      country: 'Кения', name: 'Рабочий лот', roastDate: '2026-11-02', weightKg: 2, degassingDays: 3,
      responsibleId: demo.id, allocations: [{ formatId: 'drip', purpose: '×16', weightKg: 1 }],
    })
    await expect(clearDemoData()).rejects.toThrow('Демо используется')
    expect(await db.lots.count()).toBe(5)
    expect(await db.employees.get(demo.id)).toBeDefined()
  })
})
