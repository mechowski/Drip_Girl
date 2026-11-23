import { createContext, useContext } from 'react'
import type { readAppSnapshot } from '@/persistence/snapshot'
import { DEFAULT_SETTINGS } from '@/domain/types'

export function appData(data?: Awaited<ReturnType<typeof readAppSnapshot>>) {
  return {
    lots: data?.lots ?? [], allocations: data?.allocations ?? [], productionTasks: data?.productionTasks ?? [],
    productionEntries: data?.productionEntries ?? [], inventory: data?.inventory ?? [], inventoryTransactions: data?.inventoryTransactions ?? [],
    reservations: data?.reservations ?? [], aliases: data?.aliases ?? [], sheetConnections: data?.sheetConnections ?? [],
    importedCompositions: data?.importedCompositions.filter((item) => !item.removed) ?? [], manualCompositions: data?.manualCompositions ?? [],
    assemblyPlans: data?.assemblyPlans ?? [], assemblyTasks: data?.assemblyTasks ?? [], assemblyReports: data?.assemblyReports ?? [],
    employees: data?.employees ?? [], productionDays: data?.productionDays ?? [], dailyReports: data?.dailyReports ?? [],
    warnings: data?.warnings ?? [], adjustments: data?.adjustments ?? [], auditEvents: data?.auditEvents ?? [],
    settings: data?.settings ?? DEFAULT_SETTINGS, loading: !data,
  }
}
export type AppData = ReturnType<typeof appData>
export const AppDataContext = createContext<AppData | null>(null)

export function useAppData() {
  const context = useContext(AppDataContext)
  if (!context) throw new Error('AppDataProvider отсутствует')
  return context
}
