import Dexie, { type Table } from 'dexie'
import { z } from 'zod'
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
      if (settings) await transaction.table('settings').put({ ...DEFAULT_SETTINGS, ...settings, schemaVersion: SCHEMA_VERSION })
    })
    this.on('populate', () => this.settings.add(DEFAULT_SETTINGS))
  }
}

export const db = new DripGirlDB()

export const tableNames = ['lots', 'allocations', 'productionTasks', 'productionEntries', 'inventory', 'inventoryTransactions', 'reservations', 'aliases', 'sheetConnections', 'importedCompositions', 'manualCompositions', 'assemblyPlans', 'assemblyTasks', 'assemblyReports', 'employees', 'productionDays', 'dailyReports', 'warnings', 'adjustments', 'auditEvents', 'settings'] as const

const backupSchema = z.object({ schemaVersion: z.number().int().positive(), exportedAt: z.string(), data: z.record(z.string(), z.array(z.unknown())) })

export async function exportBackup(): Promise<BackupData> {
  const data: Record<string, unknown[]> = {}
  for (const name of tableNames) data[name] = await db.table(name).toArray()
  return { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data }
}

export function validateBackup(input: unknown): BackupData {
  const parsed = backupSchema.parse(input)
  if (parsed.schemaVersion > SCHEMA_VERSION) throw new Error('Резервная копия создана более новой версией приложения')
  for (const name of tableNames) {
    if (parsed.data[name] && !Array.isArray(parsed.data[name])) throw new Error(`Повреждена таблица ${name}`)
  }
  return parsed as BackupData
}

export async function importBackup(input: unknown): Promise<void> {
  const backup = validateBackup(input)
  await db.transaction('rw', db.tables, async () => {
    for (const name of tableNames) {
      const table = db.table(name)
      await table.clear()
      const rows = backup.data[name] ?? []
      if (rows.length) await table.bulkAdd(rows)
    }
    if (!(await db.settings.get('settings'))) await db.settings.add(DEFAULT_SETTINGS)
  })
}
