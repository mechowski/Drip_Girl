import type { AppSettings, CoffeeLot, CompositionItem, FormatDefinition, FormatId, InventoryLot, LotAllocation, ProductionTask } from './types'

export const uid = () => crypto.randomUUID()
export const nowIso = () => new Date().toISOString()

export function plannedOutput(weightKg: number, coefficient: number): number {
  if (!Number.isFinite(weightKg) || weightKg < 0 || !Number.isFinite(coefficient) || coefficient <= 0) return 0
  return Math.floor((weightKg + 1e-9) / coefficient)
}

export function validateAllocations(lotWeight: number, allocations: Array<Pick<LotAllocation, 'weightKg'>>): string | null {
  if (!Number.isFinite(lotWeight) || lotWeight <= 0) return 'Вес лота должен быть положительным числом'
  if (allocations.some((item) => !Number.isFinite(item.weightKg) || item.weightKg <= 0)) return 'Вес каждого назначения должен быть положительным числом'
  const total = allocations.reduce((sum, item) => sum + item.weightKg, 0)
  if (total > lotWeight + 1e-9) return `Назначения превышают вес лота на ${(total - lotWeight).toFixed(2)} кг`
  return null
}

export function remainingCoffee(task: Pick<ProductionTask, 'sourceWeightKg' | 'producedQuantity' | 'writtenOffKg'>, format: FormatDefinition): number {
  return Math.max(0, task.sourceWeightKg - task.producedQuantity * format.coefficient - task.writtenOffKg)
}

export function coffeeDiscrepancy(task: Pick<ProductionTask, 'sourceWeightKg' | 'producedQuantity' | 'writtenOffKg'>, format: FormatDefinition): boolean {
  return task.sourceWeightKg - task.producedQuantity * format.coefficient - task.writtenOffKg < -1e-9
}

export function buildProductionTasks(lot: CoffeeLot, allocations: LotAllocation[], settings: AppSettings, schedule: typeof import('./calendar').scheduleDegassing): ProductionTask[] {
  const groups = new Map<FormatId, LotAllocation[]>()
  allocations.forEach((allocation) => groups.set(allocation.formatId, [...(groups.get(allocation.formatId) ?? []), allocation]))
  return [...groups.entries()].map(([formatId, items]) => {
    const format = settings.formats.find((item) => item.id === formatId)
    if (!format) throw new Error(`Неизвестный формат: ${formatId}`)
    const weight = items.reduce((sum, item) => sum + item.weightKg, 0)
    const days = items[0].degassingDays ?? lot.degassingDays
    const scheduled = schedule(lot.roastDate, days, settings)
    return {
      id: uid(), lotId: lot.id, formatId, sourceWeightKg: weight,
      plannedQuantity: items.reduce((sum, item) => sum + plannedOutput(item.weightKg, format.coefficient), 0),
      producedQuantity: 0, writtenOffKg: 0, readyDate: scheduled.readyDate,
      plannedDate: scheduled.plannedDate, actualDegassingDays: scheduled.actualDays,
      scheduleDecision: scheduled.decision, approved: scheduled.decision === 'none', inBU: false,
      status: 'open', comment: items.map((item) => item.comment).filter(Boolean).join('; '), createdAt: nowIso(),
    }
  })
}

export function normalizeCoffeeName(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')
}

export function coffeeKey(country: string, name: string): string {
  return `${normalizeCoffeeName(country)}|${normalizeCoffeeName(name)}`
}

export function available(inventory: Pick<InventoryLot, 'quantity' | 'reserved'>): number {
  return Math.max(0, inventory.quantity - inventory.reserved)
}

export interface StockMatch {
  item: CompositionItem
  lots: InventoryLot[]
  matched: boolean
  ambiguous: boolean
  available: number
  maxByItem: number
}

export function matchComposition(items: CompositionItem[], inventory: InventoryLot[]): StockMatch[] {
  return items.map((item) => {
    const lots = item.inventoryLotId ? inventory.filter((lot) => lot.sourceLotId === item.inventoryLotId) : inventory.filter((lot) => coffeeKey(lot.country, lot.coffeeName) === coffeeKey(item.country, item.coffeeName) && lot.formatId === item.formatId)
    const uniqueSources = [...new Set(lots.map((lot) => lot.sourceLotId))]
    const ambiguous = !item.inventoryLotId && uniqueSources.length > 1 && inventory.filter((lot) => uniqueSources.includes(lot.sourceLotId)).some((lot) => lot.country !== lots[0]?.country || lot.coffeeName !== lots[0]?.coffeeName)
    const quantity = lots.reduce((sum, lot) => sum + available(lot), 0)
    return { item, lots, matched: lots.length > 0, ambiguous, available: quantity, maxByItem: item.quantityPerSet > 0 ? Math.floor(quantity / item.quantityPerSet) : 0 }
  })
}

export function compositionCapacity(items: CompositionItem[], inventory: InventoryLot[]) {
  const matches = matchComposition(items, inventory)
  const valid = matches.every((match) => match.matched && !match.ambiguous && match.item.quantityPerSet > 0)
  const maximum = valid && matches.length ? Math.min(...matches.map((match) => match.maxByItem)) : 0
  const limiting = matches.find((match) => match.maxByItem === maximum)
  return { maximum, limiting, matches, valid }
}

export function validateCompositionItems(items: CompositionItem[]): string | null {
  if (!items.length) return 'Добавьте хотя бы одну позицию'
  if (items.some((item) => !item.country.trim() || !item.coffeeName.trim())) return 'Укажите страну и название каждого лота'
  if (items.some((item) => !Number.isInteger(item.quantityPerSet) || item.quantityPerSet <= 0)) return 'Количество должно быть целым положительным числом'
  return null
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value)
}
