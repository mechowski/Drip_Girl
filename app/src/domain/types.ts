export const SCHEMA_VERSION = 2

export type FormatId = 'drip' | 'mega' | 'smol30' | 'smol60'
export type TaskStatus = 'open' | 'completed' | 'cancelled'
export type AssemblyStatus = 'draft' | 'pending' | 'confirmed' | 'partial' | 'completed' | 'transferred' | 'cancelled'

export interface FormatDefinition {
  id: FormatId
  name: string
  coefficient: number
  unit: 'шт.'
}

export interface AppSettings {
  id: 'settings'
  schemaVersion: number
  formats: FormatDefinition[]
  purposes: string[]
  adminPassword: string
  nonWorkingDays: string[]
  workingOverrides: string[]
  theme: 'light' | 'dark'
  updatedAt: string
}

export interface CoffeeLot {
  id: string
  country: string
  name: string
  roastDate: string
  weightKg: number
  degassingDays: number
  responsibleId?: string
  comment?: string
  createdAt: string
  isDemo?: boolean
}

export interface LotAllocation {
  id: string
  lotId: string
  formatId: FormatId
  purpose: string
  weightKg: number
  degassingDays?: number
  comment?: string
  isDemo?: boolean
}

export interface ProductionTask {
  id: string
  lotId: string
  formatId: FormatId
  sourceWeightKg: number
  plannedQuantity: number
  producedQuantity: number
  writtenOffKg: number
  readyDate: string
  plannedDate: string
  actualDegassingDays: number
  scheduleDecision: 'none' | 'move' | 'bu'
  approved: boolean
  inBU: boolean
  status: TaskStatus
  responsibleId?: string
  comment?: string
  createdAt: string
  isDemo?: boolean
}

export interface ProductionEntry {
  id: string
  taskId: string
  lotId: string
  quantity: number
  responsibleId: string
  coefficientSnapshot: number
  createdAt: string
  comment?: string
  isDemo?: boolean
}

export interface InventoryLot {
  id: string
  sourceLotId: string
  productionTaskId: string
  country: string
  coffeeName: string
  formatId: FormatId
  purpose: string
  quantity: number
  reserved: number
  manufacturedAt: string
  createdAt: string
  inBU: boolean
  isDemo?: boolean
}

export type InventoryTransactionType = 'receipt' | 'reserve' | 'release' | 'consume' | 'adjust' | 'writeoff' | 'reassign'

export interface InventoryTransaction {
  id: string
  inventoryLotId: string
  type: InventoryTransactionType
  quantity: number
  previousQuantity: number
  newQuantity: number
  previousReserved?: number
  newReserved?: number
  reason?: string
  comment?: string
  assemblyTaskId?: string
  reportId?: string
  author: string
  createdAt: string
  isDemo?: boolean
}

export interface StockReservation {
  id: string
  assemblyTaskId: string
  compositionId: string
  inventoryLotId: string
  quantity: number
  consumedQuantity: number
  status: 'active' | 'completed' | 'released'
  createdAt: string
  isDemo?: boolean
}

export interface CoffeeAlias {
  id: string
  importedCountry: string
  importedName: string
  inventoryLotId: string
  createdAt: string
  isDemo?: boolean
}

export interface SheetConnection {
  id: string
  url: string
  selectedSheets: string[]
  lastSuccessAt?: string
  lastSnapshotId?: string
  lastError?: string
  isDemo?: boolean
}

export interface CompositionItem {
  id: string
  country: string
  coffeeName: string
  formatId: FormatId
  quantityPerSet: number
  inventoryLotId?: string
}

export interface ImportedComposition {
  id: string
  sheetConnectionId: string
  sheetName: string
  column: number
  name: string
  kind: 'x16' | 'x30'
  items: CompositionItem[]
  enabled: boolean
  metadata: Record<string, string>
  importedAt: string
  isDemo?: boolean
}

export interface ManualComposition {
  id: string
  name: string
  kind: 'x6' | 'mega6' | 'subscription' | 'limit'
  items: CompositionItem[]
  enabled: boolean
  createdAt: string
  isDemo?: boolean
}

export interface AssemblyPlan {
  id: string
  date: string
  status: 'draft' | 'confirmed'
  createdAt: string
  isDemo?: boolean
}

export interface AssemblyTask {
  id: string
  planId: string
  compositionId: string
  compositionKind: string
  compositionSnapshot: CompositionItem[]
  name: string
  plannedQuantity: number
  completedQuantity: number
  status: AssemblyStatus
  comment?: string
  productionDate: string
  createdAt: string
  isDemo?: boolean
}

export interface DeductionDetail {
  inventoryLotId: string
  reservationId: string
  quantity: number
  manufacturedAt: string
}

export interface AssemblyReport {
  id: string
  taskId: string
  employeeId: string
  quantity: number
  deductions: DeductionDetail[]
  createdAt: string
  comment?: string
  correctionComment?: string
  previousQuantity?: number
  correctedAt?: string
  productionDate: string
  isDemo?: boolean
}

export interface Employee {
  id: string
  lastName: string
  firstName: string
  active: boolean
  createdAt: string
  isDemo?: boolean
}

export interface ProductionDay {
  id: string
  date: string
  status: 'open' | 'closed'
  closedAt?: string
  nextWorkingDate?: string
  isDemo?: boolean
}

export interface DailyReport {
  id: string
  date: string
  produced: ProductionEntry[]
  assembled: Array<{
    taskId: string
    name: string
    plan: number
    fact: number
    remaining: number
    employees: string[]
    comments: string[]
  }>
  warnings: Warning[]
  createdAt: string
  isDemo?: boolean
}

export type WarningType = 'calendar' | 'bu' | 'unmatched' | 'import' | 'shortage' | 'reassign' | 'employee' | 'adjustment' | 'unfinished' | 'discrepancy'

export interface Warning {
  id: string
  type: WarningType
  message: string
  read: boolean
  lotId?: string
  taskId?: string
  reportId?: string
  createdAt: string
  isDemo?: boolean
}

export interface AdminAdjustment {
  id: string
  entityType: 'inventory' | 'report' | 'production'
  entityId: string
  previousValue: number
  newValue: number
  reason: string
  comment?: string
  createdAt: string
  isDemo?: boolean
}

export interface AuditEvent {
  id: string
  action: string
  entityType: string
  entityId: string
  description: string
  createdAt: string
  isDemo?: boolean
}

export interface BackupData {
  schemaVersion: number
  exportedAt: string
  data: Record<string, unknown[]>
}

export const DEFAULT_SETTINGS: AppSettings = {
  id: 'settings',
  schemaVersion: SCHEMA_VERSION,
  formats: [
    { id: 'drip', name: 'Обычный дрип', coefficient: 0.0121, unit: 'шт.' },
    { id: 'mega', name: 'Мега', coefficient: 0.022, unit: 'шт.' },
    { id: 'smol30', name: 'СМОЛ 30 г', coefficient: 0.035, unit: 'шт.' },
    { id: 'smol60', name: 'СМОЛ 60 г', coefficient: 0.07, unit: 'шт.' },
  ],
  purposes: ['×6', '×16', '×30', 'СТМ', 'Мега', 'Подписка', 'Лимита', '30 г', '60 г'],
  adminPassword: '1337',
  nonWorkingDays: ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-05-01', '2026-05-11', '2026-06-12', '2026-11-04'],
  workingOverrides: [],
  theme: 'light',
  updatedAt: new Date().toISOString(),
}
