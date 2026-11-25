import { createPostgresStore } from './postgres-store.mjs'

export const tableNames = [
  'lots', 'allocations', 'productionTasks', 'productionEntries', 'inventory',
  'inventoryTransactions', 'reservations', 'expectedReservations', 'aliases',
  'sheetConnections', 'importedCompositions', 'manualCompositions', 'assemblyPlans',
  'assemblyTasks', 'assemblyReports', 'employees', 'productionDays', 'dailyReports',
  'warnings', 'adjustments', 'auditEvents', 'settings',
]

export let db
export function configureStore(pool) {
  db = createPostgresStore(pool, tableNames)
  return db
}

export function hasAdminSession() {
  return db.hasAdminSession()
}
