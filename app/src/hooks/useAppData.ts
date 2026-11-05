import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/persistence/db'
import { DEFAULT_SETTINGS } from '@/domain/types'

export function useAppData() {
  const data = useLiveQuery(async () => {
    const [lots, allocations, productionTasks, productionEntries, inventory, inventoryTransactions, reservations, aliases, sheetConnections, importedCompositions, manualCompositions, assemblyPlans, assemblyTasks, assemblyReports, employees, productionDays, dailyReports, warnings, adjustments, auditEvents, settings] = await Promise.all([
      db.lots.toArray(), db.allocations.toArray(), db.productionTasks.toArray(), db.productionEntries.toArray(), db.inventory.toArray(), db.inventoryTransactions.toArray(), db.reservations.toArray(), db.aliases.toArray(), db.sheetConnections.toArray(), db.importedCompositions.toArray(), db.manualCompositions.toArray(), db.assemblyPlans.toArray(), db.assemblyTasks.toArray(), db.assemblyReports.toArray(), db.employees.toArray(), db.productionDays.toArray(), db.dailyReports.toArray(), db.warnings.toArray(), db.adjustments.toArray(), db.auditEvents.toArray(), db.settings.get('settings'),
    ])
    return { lots, allocations, productionTasks, productionEntries, inventory, inventoryTransactions, reservations, aliases, sheetConnections, importedCompositions, manualCompositions, assemblyPlans, assemblyTasks, assemblyReports, employees, productionDays, dailyReports, warnings, adjustments, auditEvents, settings: settings ?? DEFAULT_SETTINGS }
  }, [])
  return {
    lots: data?.lots ?? [], allocations: data?.allocations ?? [], productionTasks: data?.productionTasks ?? [],
    productionEntries: data?.productionEntries ?? [], inventory: data?.inventory ?? [], inventoryTransactions: data?.inventoryTransactions ?? [],
    reservations: data?.reservations ?? [], aliases: data?.aliases ?? [], sheetConnections: data?.sheetConnections ?? [],
    importedCompositions: data?.importedCompositions ?? [], manualCompositions: data?.manualCompositions ?? [],
    assemblyPlans: data?.assemblyPlans ?? [], assemblyTasks: data?.assemblyTasks ?? [], assemblyReports: data?.assemblyReports ?? [],
    employees: data?.employees ?? [], productionDays: data?.productionDays ?? [], dailyReports: data?.dailyReports ?? [],
    warnings: data?.warnings ?? [], adjustments: data?.adjustments ?? [], auditEvents: data?.auditEvents ?? [],
    settings: data?.settings ?? DEFAULT_SETTINGS, loading: !data,
  }
}
export type AppData = ReturnType<typeof useAppData>
