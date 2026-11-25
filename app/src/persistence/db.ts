import Dexie, { type Table } from 'dexie'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import { dayKey, nextWorkingDay, scheduleDegassing } from '@/domain/calendar'
import { buildProductionTasks, isPrivateLabel, lotHasProductionActivity, matchesTaskAllocation, nowIso, productionScheduleWarning, sameSchedule, uid } from '@/domain/calculations'
import { singleLotSetName } from '@/domain/compositions'
import { backupEnvelope, rowSchemas } from './backupSchema'
import { DEFAULT_SETTINGS, SCHEMA_VERSION, type AdminAdjustment, type AppSettings, type AssemblyPlan, type AssemblyReport, type AssemblyTask, type AuditEvent, type BackupData, type CoffeeAlias, type CoffeeLot, type DailyReport, type Employee, type ExpectedReservation, type ImportedComposition, type InventoryLot, type InventoryTransaction, type LotAllocation, type ManualComposition, type ProductionDay, type ProductionEntry, type ProductionTask, type SheetConnection, type StockReservation, type Warning } from '@/domain/types'

export class DripGirlDB extends Dexie {
  lots!: Table<CoffeeLot, string>
  allocations!: Table<LotAllocation, string>
  productionTasks!: Table<ProductionTask, string>
  productionEntries!: Table<ProductionEntry, string>
  inventory!: Table<InventoryLot, string>
  inventoryTransactions!: Table<InventoryTransaction, string>
  reservations!: Table<StockReservation, string>
  expectedReservations!: Table<ExpectedReservation, string>
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
    this.version(4).stores({}).upgrade(async (transaction) => {
      const table = transaction.table<ManualComposition>('manualCompositions')
      await table.bulkPut((await table.toArray()).map(withSingleLotName))
      await transaction.table('settings').put(normalizeSettings(await transaction.table('settings').get('settings')))
    })
    this.version(5).stores({}).upgrade(async (transaction) => {
      const settings = normalizeSettings(await transaction.table('settings').get('settings'))
      const [lots, allocations, tasks, entries, inventory, warnings] = await Promise.all([
        transaction.table<CoffeeLot>('lots').toArray(),
        transaction.table<LotAllocation>('allocations').toArray(),
        transaction.table<ProductionTask>('productionTasks').toArray(),
        transaction.table<ProductionEntry>('productionEntries').toArray(),
        transaction.table<InventoryLot>('inventory').toArray(),
        transaction.table<Warning>('warnings').toArray(),
      ])
      const migrated = migratePurposeTasks(settings, lots, allocations, tasks, entries, inventory, warnings)
      await transaction.table('productionTasks').bulkPut(migrated.tasks)
      await transaction.table('warnings').bulkPut(migrated.warnings)
      await transaction.table('inventory').bulkPut(inventory.map(withSharedStock))
      await transaction.table('settings').put(settings)
    })
    this.version(6).stores({ expectedReservations: 'id, assemblyTaskId, productionTaskId' }).upgrade(async (transaction) => {
      const table = transaction.table('settings')
      await table.put(normalizeSettings(await table.get('settings')))
    })
    this.version(7).stores({}).upgrade(async (transaction) => {
      const table = transaction.table('settings')
      await table.put(normalizeSettings(await table.get('settings')))
    })
    this.on('populate', () => this.settings.add(DEFAULT_SETTINGS))
  }
}

export const db = new DripGirlDB()

export const tableNames = ['lots', 'allocations', 'productionTasks', 'productionEntries', 'inventory', 'inventoryTransactions', 'reservations', 'expectedReservations', 'aliases', 'sheetConnections', 'importedCompositions', 'manualCompositions', 'assemblyPlans', 'assemblyTasks', 'assemblyReports', 'employees', 'productionDays', 'dailyReports', 'warnings', 'adjustments', 'auditEvents', 'settings'] as const

function withSingleLotName(composition: ManualComposition): ManualComposition {
  return { ...composition, name: singleLotSetName(composition.kind, composition.items[0]) || composition.name }
}

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

function withSharedStock(lot: InventoryLot): InventoryLot {
  return { ...lot, shared: !isPrivateLabel(lot.purpose) }
}

function migratePurposeTasks(
  settings: AppSettings, lots: CoffeeLot[], allocations: LotAllocation[], tasks: ProductionTask[],
  entries: ProductionEntry[], inventory: InventoryLot[], warnings: Warning[],
) {
  const lotIndex = new Map(lots.map((lot) => [lot.id, lot]))
  const allocationsByLot = new Map<string, LotAllocation[]>()
  for (const allocation of allocations) {
    const group = allocationsByLot.get(allocation.lotId)
    if (group) group.push(allocation)
    else allocationsByLot.set(allocation.lotId, [allocation])
  }
  const activeIds = new Set([...entries.map((entry) => entry.taskId), ...inventory.map((lot) => lot.productionTaskId)])
  const replacedIds = new Set<string>()
  const newWarnings: Warning[] = []
  const migratedTasks = tasks.flatMap((task) => {
    if (task.purpose !== undefined || task.status !== 'open' || lotHasProductionActivity([task], activeIds.has(task.id), false)) return [task]
    const lot = lotIndex.get(task.lotId)
    const relevant = allocationsByLot.get(task.lotId)?.filter((allocation) => matchesTaskAllocation(task, allocation))
    if (!lot || !relevant?.length || !settings.formats.some((format) => format.id === task.formatId)) return [task]
    if (new Set(relevant.map((allocation) => allocation.purpose)).size === 1) return [{ ...task, purpose: relevant[0].purpose }]

    const planningSettings = { ...settings, formats: settings.formats.map((format) => format.id === task.formatId
      ? { ...format, coefficient: task.coefficientSnapshot ?? format.coefficient } : format) }
    replacedIds.add(task.id)
    return buildProductionTasks(lot, relevant, planningSettings, scheduleDegassing).map((planned, index) => {
      const next = {
        ...planned,
        id: index === 0 ? task.id : planned.id,
        createdAt: task.createdAt,
        approved: planned.approved || (sameSchedule(task, planned) && task.approved),
        responsibleId: task.responsibleId,
        isDemo: task.isDemo,
      }
      const warning = productionScheduleWarning(lot, next)
      if (!next.approved && warning) newWarnings.push({
        ...warning, id: uid(), lotId: lot.id, taskId: next.id, read: false, createdAt: nowIso(), isDemo: task.isDemo,
      })
      return next
    })
  })
  return {
    tasks: migratedTasks,
    warnings: warnings.map((warning) => warning.taskId && replacedIds.has(warning.taskId) && (warning.type === 'bu' || warning.type === 'calendar')
      ? { ...warning, read: true } : warning).concat(newWarnings),
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
  const missing = tableNames.filter((name) => !Object.hasOwn(backup.data, name) && (name !== 'expectedReservations' || backup.schemaVersion >= 6))
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
  const claims = (backup.data.expectedReservations ?? []) as ExpectedReservation[]
  if (claims.length) {
    const tasks = new Map((backup.data.assemblyTasks as AssemblyTask[]).map((row) => [row.id, row]))
    const productionTasks = new Set((backup.data.productionTasks as ProductionTask[]).map(({ id }) => id))
    const reports = new Map((backup.data.assemblyReports as AssemblyReport[]).map((row) => [row.id, row]))
    for (const claim of claims) {
      const task = tasks.get(claim.assemblyTaskId)
      if (!task || !task.compositionSnapshot.some(({ id }) => id === claim.compositionItemId) ||
        !productionTasks.has(claim.productionTaskId) ||
        claim.reported.some(({ reportId }) => reports.get(reportId)?.taskId !== task.id)) {
        throw new Error('В копии нарушена связь резерва под выпуск с заданием или отчётом')
      }
    }
  }
  return backup
}

export async function importBackup(input: unknown): Promise<void> {
  const backup = validateBackup(input)
  const data: BackupData['data'] = { ...backup.data, expectedReservations: backup.data.expectedReservations ?? [] }
  const settings = normalizeSettings(data.settings[0] as Partial<AppSettings> | undefined)
  if (backup.schemaVersion < 3) {
    const migrated = migrateProduction(settings, data.lots as CoffeeLot[], data.productionTasks as ProductionTask[], data.inventory as InventoryLot[])
    data.productionTasks = migrated.tasks
    data.inventory = migrated.inventory
  }
  if (backup.schemaVersion < 5) {
    const migrated = migratePurposeTasks(settings, data.lots as CoffeeLot[], data.allocations as LotAllocation[],
      data.productionTasks as ProductionTask[], data.productionEntries as ProductionEntry[],
      data.inventory as InventoryLot[], data.warnings as Warning[])
    data.productionTasks = migrated.tasks
    data.warnings = migrated.warnings
    data.inventory = (data.inventory as InventoryLot[]).map(withSharedStock)
  }
  data.manualCompositions = (data.manualCompositions as ManualComposition[]).map(withSingleLotName)
  data.settings = [settings]

  await db.transaction('rw', db.tables, async () => {
    for (const name of tableNames) {
      const table = db.table(name)
      await table.clear()
      if (data[name].length) await table.bulkAdd(data[name])
    }
  })
}

export async function resetAppData(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) {
      await table.clear()
    }
    await db.settings.add(DEFAULT_SETTINGS)
  })
}
