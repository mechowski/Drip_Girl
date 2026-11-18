import Dexie, { type Table } from 'dexie'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import { dayKey, nextWorkingDay } from '@/domain/calendar'
import { backupEnvelope, rowSchemas } from './backupSchema'
import { DEFAULT_SETTINGS, SCHEMA_VERSION, type AdminAdjustment, type AppSettings, type AssemblyPlan, type AssemblyReport, type AssemblyTask, type AuditEvent, type BackupData, type CoffeeAlias, type CoffeeLot, type DailyReport, type Employee, type ImportedComposition, type InventoryLot, type InventoryTransaction, type LotAllocation, type ManualComposition, type ProductionDay, type ProductionEntry, type ProductionTask, type SheetConnection, type StockReservation, type Warning } from '@/domain/types'

export class DripGirlDB extends Dexie {
  lots!: Table<CoffeeLot, string>
  allocations!: Table<LotAllocation, string>
  productionTasks!: Table<ProductionTask, string>
  productionEntries!: Table<ProductionEntry, string>
  inventory!: Table<InventoryLot, string>
  inventoryTransactions!: Table<InventoryTransaction, string>
  reservations!: Table<StockReservation, string>
  aliases!: Table<CoffeeAlias, string>
  sheetConnections!: Table<SheetConnection, string>
  importedCompositions!: Table<ImportedComposition, string>
  manualCompositions!: Table<ManualComposition, string>
  assemblyPlans!: Table<AssemblyPlan, string>
  assemblyTasks!: Table<AssemblyTask, string>
  assemblyReports!: Table<AssemblyReport, string>
  employees!: Table<Employee, string>
  productionDays!: Table<ProductionDay, string>
  dailyReports!: Table<DailyReport, string>
  warnings!: Table<Warning, string>
  adjustments!: Table<AdminAdjustment, string>
  auditEvents!: Table<AuditEvent, string>
  settings!: Table<AppSettings, string>

  constructor() {
    super('drip-girl-production')
    this.version(1).stores({
      lots: 'id, country, roastDate', allocations: 'id, lotId', productionTasks: 'id, lotId, status, plannedDate',
      productionEntries: 'id, taskId, createdAt', inventory: 'id, sourceLotId, formatId, purpose, manufacturedAt',
      inventoryTransactions: 'id, inventoryLotId, createdAt', reservations: 'id, assemblyTaskId, inventoryLotId, status',
      aliases: 'id, inventoryLotId', sheetConnections: 'id', importedCompositions: 'id, sheetConnectionId, enabled',
      manualCompositions: 'id, enabled', assemblyPlans: 'id, date, status', assemblyTasks: 'id, planId, status, productionDate',
      assemblyReports: 'id, taskId, employeeId, createdAt', employees: 'id, active', productionDays: 'id, date, status',
      dailyReports: 'id, date', warnings: 'id, read, type, createdAt', adjustments: 'id, entityId',
      auditEvents: 'id, entityId, createdAt', settings: 'id',
    }).upgrade(async () => undefined)
    this.version(2).stores({ settings: 'id', inventory: 'id, sourceLotId, productionTaskId, formatId, purpose, manufacturedAt' }).upgrade(async (transaction) => {
      const settings = await transaction.table('settings').get('settings')
      if (settings) await transaction.table('settings').put({ ...DEFAULT_SETTINGS, ...settings, schemaVersion: 2 })
    })
    this.version(3).stores({}).upgrade(async (transaction) => {
      const settings = normalizeSettings(await transaction.table('settings').get('settings'))
      const lots = await transaction.table<CoffeeLot>('lots').toArray()
      const tasks = await transaction.table<ProductionTask>('productionTasks').toArray()
      const inventory = await transaction.table<InventoryLot>('inventory').toArray()
      const migrated = migrateProduction(settings, lots, tasks, inventory)
      await transaction.table('settings').put(settings)
      await transaction.table('productionTasks').bulkPut(migrated.tasks)
      await transaction.table('inventory').bulkPut(migrated.inventory)
    })
    this.on('populate', () => this.settings.add(DEFAULT_SETTINGS))
  }
}

export const db = new DripGirlDB()

export const tableNames = ['lots', 'allocations', 'productionTasks', 'productionEntries', 'inventory', 'inventoryTransactions', 'reservations', 'aliases', 'sheetConnections', 'importedCompositions', 'manualCompositions', 'assemblyPlans', 'assemblyTasks', 'assemblyReports', 'employees', 'productionDays', 'dailyReports', 'warnings', 'adjustments', 'auditEvents', 'settings'] as const

function normalizeSettings(settings?: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...settings, id: 'settings', schemaVersion: SCHEMA_VERSION }
}

function migrateProduction(settings: AppSettings, lots: CoffeeLot[], tasks: ProductionTask[], inventory: InventoryLot[]) {
  const roastDates = new Map(lots.map((lot) => [lot.id, lot.roastDate]))
  const tasksByLotFormat = new Map<string, ProductionTask[]>()
  for (const task of tasks) {
    const key = `${task.lotId}/${task.formatId}`
    tasksByLotFormat.set(key, [...(tasksByLotFormat.get(key) ?? []), task])
  }
  return {
    tasks: tasks.map((task) => {
      if (task.scheduleDecision !== 'bu' || task.buDate) return task
      const roastDate = roastDates.get(task.lotId)
      if (!roastDate) return task
      const next = nextWorkingDay(task.readyDate, settings)
      return { ...task, buDate: task.plannedDate, plannedDate: dayKey(next), actualDegassingDays: differenceInCalendarDays(next, parseISO(roastDate)) }
    }),
    inventory: inventory.map((lot) => {
      if (lot.productionTaskId) return lot
      const matches = tasksByLotFormat.get(`${lot.sourceLotId}/${lot.formatId}`)
      return matches?.length === 1 ? { ...lot, productionTaskId: matches[0].id } : lot
    }),
  }
}

export async function exportBackup(): Promise<BackupData> {
  return db.transaction('r', db.tables, async () => {
    const tables = await Promise.all(tableNames.map(async (name) => [name, await db.table(name).toArray()] as const))
    return { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data: Object.fromEntries(tables) }
  })
}

export function validateBackup(input: unknown): BackupData {
  if (input && typeof input === 'object' && 'schemaVersion' in input
    && typeof input.schemaVersion === 'number' && input.schemaVersion > SCHEMA_VERSION) {
    throw new Error('Резервная копия создана более новой версией приложения')
  }
  const envelope = backupEnvelope.safeParse(input)
  if (!envelope.success) throw new Error('Ожидается версия схемы, дата экспорта и набор таблиц')
  const backup = envelope.data
  for (const name of Object.keys(backup.data)) {
    if (!Object.hasOwn(rowSchemas, name)) throw new Error(`Неизвестная таблица: ${name}`)
  }
  for (const name of tableNames) {
    const ids = new Set<string>()
    const rows = backup.data[name]
    if (!rows) continue
    for (const [index, row] of rows.entries()) {
      const id = row && typeof row === 'object' && 'id' in row ? row.id : undefined
      if (typeof id !== 'string' || !id.trim()) throw new Error(`В таблице ${name} есть запись без идентификатора`)
      if (ids.has(id)) throw new Error(`В таблице ${name} повторяется идентификатор записи`)
      ids.add(id)
      const candidate = name === 'settings' && backup.schemaVersion < SCHEMA_VERSION
        ? normalizeSettings(row as Partial<AppSettings>) : row
      const result = rowSchemas[name].safeParse(candidate)
      if (!result.success) {
        const problem = result.error.issues[0]
        const field = problem.path.join('.') || 'запись'
        const detail = problem.code === 'custom' ? `: ${problem.message}` : ''
        throw new Error(`Таблица ${name}, строка ${index + 1}: некорректное поле «${field}»${detail}`)
      }
    }
  }
  const missing = tableNames.filter((name) => !Object.hasOwn(backup.data, name))
  if (missing.length) throw new Error(`В копии отсутствуют таблицы: ${missing.join(', ')}`)
  if (backup.schemaVersion === SCHEMA_VERSION && backup.data.settings.length !== 1) {
    throw new Error('В копии должна быть одна запись настроек')
  }

  // The amount recorded on each lot must cover exactly its open reservations.
  const stock = new Map((backup.data.inventory as InventoryLot[]).map((lot) => [lot.id, lot]))
  const reserved = new Map<string, number>()
  for (const entry of backup.data.reservations as StockReservation[]) {
    if (entry.status !== 'active') continue
    if (!stock.has(entry.inventoryLotId)) throw new Error('В копии есть активный резерв для отсутствующей партии')
    const balance = entry.quantity - entry.consumedQuantity
    reserved.set(entry.inventoryLotId, (reserved.get(entry.inventoryLotId) ?? 0) + balance)
  }
  for (const lot of stock.values()) {
    if (lot.reserved !== (reserved.get(lot.id) ?? 0)) {
      throw new Error(`В копии не сходится резерв партии ${lot.country} / ${lot.coffeeName}`)
    }
  }
  return backup
}

export async function importBackup(input: unknown): Promise<void> {
  const backup = validateBackup(input)
  const data = { ...backup.data }
  const settings = normalizeSettings(data.settings[0] as Partial<AppSettings> | undefined)
  if (backup.schemaVersion < SCHEMA_VERSION) {
    const migrated = migrateProduction(settings, data.lots as CoffeeLot[], data.productionTasks as ProductionTask[], data.inventory as InventoryLot[])
    data.productionTasks = migrated.tasks
    data.inventory = migrated.inventory
  }
  data.settings = [settings]

  await db.transaction('rw', db.tables, async () => {
    for (const name of tableNames) {
      const table = db.table(name)
      await table.clear()
      if (data[name].length) await table.bulkAdd(data[name])
    }
  })
}
