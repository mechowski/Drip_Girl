import { db } from './db'
import { DEFAULT_SETTINGS } from '@/domain/types'

export function readAppSnapshot() {
  return db.transaction('r', db.tables, async () => {
    const [lots, allocations, productionTasks, productionEntries, inventory, inventoryTransactions, reservations, aliases, sheetConnections, importedCompositions, manualCompositions, assemblyPlans, assemblyTasks, assemblyReports, employees, productionDays, dailyReports, warnings, adjustments, auditEvents, settings] = await Promise.all([
      db.lots.toArray(), db.allocations.toArray(), db.productionTasks.toArray(), db.productionEntries.toArray(), db.inventory.toArray(), db.inventoryTransactions.toArray(), db.reservations.toArray(), db.aliases.toArray(), db.sheetConnections.toArray(), db.importedCompositions.toArray(), db.manualCompositions.toArray(), db.assemblyPlans.toArray(), db.assemblyTasks.toArray(), db.assemblyReports.toArray(), db.employees.toArray(), db.productionDays.toArray(), db.dailyReports.toArray(), db.warnings.toArray(), db.adjustments.toArray(), db.auditEvents.toArray(), db.settings.get('settings'),
    ])
    return { lots, allocations, productionTasks, productionEntries, inventory, inventoryTransactions, reservations, aliases, sheetConnections, importedCompositions, manualCompositions, assemblyPlans, assemblyTasks, assemblyReports, employees, productionDays, dailyReports, warnings, adjustments, auditEvents, settings: settings ?? DEFAULT_SETTINGS }
  })
}
