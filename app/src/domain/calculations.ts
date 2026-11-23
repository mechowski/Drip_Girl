import type { AppSettings, AssemblyTask, CoffeeLot, CompositionItem, FormatDefinition, FormatId, InventoryLot, LotAllocation, ProductionEntry, ProductionTask } from './types'

export function uid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export const nowIso = () => new Date().toISOString()

export function plannedOutput(weightKg: number, coefficient: number): number {
  if (!Number.isFinite(weightKg) || weightKg < 0 || !Number.isFinite(coefficient) || coefficient <= 0) return 0
  const quotient = weightKg / coefficient
  return Math.floor(quotient * (1 + Number.EPSILON))
}

export function validateAllocations(lotWeight: number, allocations: Array<Pick<LotAllocation, 'weightKg'>>): string | null {
  if (!Number.isFinite(lotWeight) || lotWeight <= 0) return 'Вес лота должен быть положительным числом'
  if (allocations.some((item) => !Number.isFinite(item.weightKg) || item.weightKg <= 0)) return 'Вес каждого назначения должен быть положительным числом'
  const total = allocations.reduce((sum, item) => sum + item.weightKg, 0)
  if (total > lotWeight + 1e-9) return `Назначения превышают вес лота на ${(total - lotWeight).toFixed(2)} кг`
  return null
}

const allocationWeightFormat = new Intl.NumberFormat('en', { useGrouping: false, maximumSignificantDigits: 14 })

export function distributeAllocationWeights(total: string, manualWeights: readonly (string | undefined)[]): string[] {
  if (manualWeights.length === 1) return [total]
  const automaticCount = manualWeights.filter((weight) => weight === undefined).length
  const manualTotal = manualWeights.reduce<number>((sum, weight) => sum + (Number(weight) || 0), 0)
  const weight = Number(total)
  let remaining = Number.isFinite(weight) && Number.isFinite(manualTotal) ? Math.max(0, weight - manualTotal) : 0
  let unassigned = automaticCount
  const share = automaticCount > 0 ? remaining / automaticCount : 0
  const rounded = Number(share.toPrecision(14))
  return manualWeights.map((weight) => {
    if (weight !== undefined) return weight
    const amount = --unassigned === 0 ? remaining : Math.min(remaining, rounded)
    remaining -= amount
    return allocationWeightFormat.format(amount)
  })
}

export function lotHasProductionActivity(tasks: ProductionTask[], hasEntries: boolean, hasStock: boolean): boolean {
  return hasEntries || hasStock || tasks.some((task) =>
    task.producedQuantity > 0 || task.writtenOffKg > 0 || task.inBU || task.status === 'completed')
}

type CoffeeConsumption = Pick<ProductionTask, 'sourceWeightKg' | 'producedQuantity' | 'writtenOffKg' | 'coefficientSnapshot'>
type QuantitySnapshot = Pick<ProductionEntry, 'quantity' | 'coefficientSnapshot'>

function coffeeBalance(task: CoffeeConsumption, format: FormatDefinition, entries: QuantitySnapshot[]): number {
  const historicalWeight = entries.reduce((sum, entry) => sum + entry.quantity * entry.coefficientSnapshot, 0)
  const historicalQuantity = entries.reduce((sum, entry) => sum + entry.quantity, 0)
  const unrecordedQuantity = Math.max(0, task.producedQuantity - historicalQuantity)
  return task.sourceWeightKg - historicalWeight - unrecordedQuantity * (task.coefficientSnapshot ?? format.coefficient) - task.writtenOffKg
}

export function remainingCoffee(task: CoffeeConsumption, format: FormatDefinition, entries: QuantitySnapshot[] = []): number {
  return Math.max(0, coffeeBalance(task, format, entries))
}

export function coffeeDiscrepancy(task: CoffeeConsumption, format: FormatDefinition, entries: QuantitySnapshot[] = []): boolean {
  return coffeeBalance(task, format, entries) < -1e-9
}

export function purposesForFormat(formatId: FormatId, purposes: string[]): string[] {
  if (formatId === 'smol30') return ['30 г']
  if (formatId === 'smol60') return ['60 г']
  return purposes.filter((purpose) => purpose !== '30 г' && purpose !== '60 г')
}

type ReceiptHistory = Pick<ProductionEntry, 'quantity' | 'purposeQuantities'>

export function splitProductionReceipt(
  quantity: number,
  allocations: LotAllocation[],
  coefficient: number,
  producedQuantity: number,
  history: ReceiptHistory[],
): Record<string, number> {
  const targets = new Map<string, number>()
  for (const allocation of [...allocations].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id))) {
    targets.set(allocation.purpose, (targets.get(allocation.purpose) ?? 0) + plannedOutput(allocation.weightKg, coefficient))
  }
  if (!targets.size) throw new Error('У задачи нет плановых назначений')

  const recorded = new Map<string, number>()
  let legacyQuantity = producedQuantity
  for (const entry of history) {
    if (!entry.purposeQuantities) continue
    legacyQuantity -= entry.quantity
    for (const [purpose, amount] of Object.entries(entry.purposeQuantities)) {
      recorded.set(purpose, (recorded.get(purpose) ?? 0) + amount)
    }
  }

  const receipts = new Map<string, number>()
  let remaining = quantity
  const lastPurpose = [...targets.keys()].at(-1)
  for (const [purpose, target] of targets) {
    const historical = Math.min(target, Math.max(0, legacyQuantity))
    legacyQuantity -= historical
    const unfilled = Math.max(0, target - historical - (recorded.get(purpose) ?? 0))
    const part = purpose === lastPurpose ? remaining : Math.min(remaining, unfilled)
    if (part > 0) receipts.set(purpose, part)
    remaining -= part
    if (remaining === 0) break
  }
  return Object.fromEntries(receipts)
}

export function plannedTaskSchedule(lot: CoffeeLot, allocations: LotAllocation[], settings: AppSettings, schedule: typeof import('./calendar').scheduleDegassing) {
  // A format is produced together once every allocation is ready.
  const days = Math.max(...allocations.map((allocation) => allocation.degassingDays ?? lot.degassingDays))
  const scheduled = schedule(lot.roastDate, days, settings)
  return {
    readyDate: scheduled.readyDate,
    plannedDate: scheduled.plannedDate,
    buDate: scheduled.buDate,
    actualDegassingDays: scheduled.actualDays,
    scheduleDecision: scheduled.decision,
  }
}

export function buildProductionTasks(lot: CoffeeLot, allocations: LotAllocation[], settings: AppSettings, schedule: typeof import('./calendar').scheduleDegassing): ProductionTask[] {
  const groups = new Map<FormatId, LotAllocation[]>()
  allocations.forEach((allocation) => groups.set(allocation.formatId, [...(groups.get(allocation.formatId) ?? []), allocation]))
  return [...groups.entries()].map(([formatId, items]) => {
    const format = settings.formats.find((item) => item.id === formatId)
    if (!format) throw new Error(`Неизвестный формат: ${formatId}`)
    const weight = items.reduce((sum, item) => sum + item.weightKg, 0)
    const plannedQuantity = items.reduce((sum, item) => sum + plannedOutput(item.weightKg, format.coefficient), 0)
    if (!Number.isSafeInteger(plannedQuantity)) throw new Error(`Слишком большое плановое количество для формата «${format.name}»`)
    const scheduled = plannedTaskSchedule(lot, items, settings, schedule)
    return {
      id: uid(), lotId: lot.id, formatId, sourceWeightKg: weight, coefficientSnapshot: format.coefficient,
      plannedQuantity,
      producedQuantity: 0, writtenOffKg: 0, ...scheduled,
      approved: scheduled.scheduleDecision === 'none', inBU: false,
      status: 'open', comment: items.map((item) => item.comment).filter(Boolean).join('\n'), createdAt: nowIso(),
    }
  })
}

export const strictCoffeeName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')
export const exactCoffeeKey = (country: string, name: string) => JSON.stringify([strictCoffeeName(country), strictCoffeeName(name)])

export function normalizeCoffeeName(value: string): string {
  return strictCoffeeName(value).replace(/ё/g, 'е')
}

export function coffeeKey(country: string, name: string): string {
  return JSON.stringify([normalizeCoffeeName(country), normalizeCoffeeName(name)])
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
    const compatible = inventory.filter((lot) => lot.formatId === item.formatId)
    const candidates = item.inventoryLotId
      ? compatible.filter((lot) => lot.sourceLotId === item.inventoryLotId)
      : compatible.filter((lot) => coffeeKey(lot.country, lot.coffeeName) === coffeeKey(item.country, item.coffeeName))
    const exact = candidates.filter((lot) => exactCoffeeKey(lot.country, lot.coffeeName) === exactCoffeeKey(item.country, item.coffeeName))
    const lots = !item.inventoryLotId && exact.length ? exact : candidates
    const ambiguous = !item.inventoryLotId && new Set(lots.map((lot) => exactCoffeeKey(lot.country, lot.coffeeName))).size > 1
    const quantity = lots.reduce((sum, lot) => sum + available(lot), 0)
    return { item, lots, matched: lots.length > 0, ambiguous, available: quantity, maxByItem: item.quantityPerSet > 0 ? Math.floor(quantity / item.quantityPerSet) : 0 }
  })
}

const assemblyPurposes: Record<string, string> = { x6: '×6', mega6: 'Мега', x16: '×16', x30: '×30', subscription: 'Подписка', limit: 'Лимита' }

const isAssemblyFormat = (formatId: FormatId) => formatId === 'drip' || formatId === 'mega'

export function compareStockFifo(a: InventoryLot, b: InventoryLot): number {
  return Date.parse(a.manufacturedAt) - Date.parse(b.manufacturedAt)
    || Date.parse(a.createdAt) - Date.parse(b.createdAt)
    || a.id.localeCompare(b.id)
}

export interface StockDemand {
  item: CompositionItem
  quantity: number
  purpose?: string
  taskId?: string
  name?: string
}

export function matchDemands(items: CompositionItem[], count: number, kind?: string): StockDemand[] {
  return items.map((item) => ({ item, quantity: item.quantityPerSet * count, purpose: kind ? assemblyPurposes[kind] : undefined }))
}

export function taskDemands(tasks: AssemblyTask[]): StockDemand[] {
  return tasks.flatMap((task) => matchDemands(task.compositionSnapshot, task.plannedQuantity, task.compositionKind)
    .map((demand) => ({ ...demand, taskId: task.id, name: task.name })))
}

interface StockAllocation {
  demand: StockDemand
  lot: InventoryLot
  quantity: number
}

type ShortageReason = 'unmatched' | 'ambiguous' | 'unsupported' | 'quantity' | 'shortage'

interface StockShortage {
  demand: StockDemand
  quantity: number
  reason: ShortageReason
}

export function allocateStock(demands: StockDemand[], inventory: InventoryLot[]) {
  const remaining = new Map(inventory.map((lot) => [lot.id, available(lot)]))
  const allocations: StockAllocation[] = []
  const shortages: StockShortage[] = []
  const matches = demands.map((demand) => ({ demand, match: matchComposition([demand.item], inventory)[0] }))
  // Explicit source requirements use a subset of the stock available to a shared coffee name.
  matches.sort((a, b) => Number(Boolean(b.demand.item.inventoryLotId)) - Number(Boolean(a.demand.item.inventoryLotId)))
  for (const { demand, match } of matches) {
    const issue = !Number.isSafeInteger(demand.quantity) || demand.quantity <= 0 ? 'quantity'
      : !isAssemblyFormat(demand.item.formatId) ? 'unsupported'
      : match.ambiguous ? 'ambiguous' : !match.matched ? 'unmatched' : undefined
    if (issue) {
      shortages.push({ demand, quantity: demand.quantity, reason: issue })
      continue
    }
    let needed = demand.quantity
    const compatibleStock = [...match.lots].sort((a, b) =>
      Number(Boolean(demand.purpose && b.purpose === demand.purpose)) - Number(Boolean(demand.purpose && a.purpose === demand.purpose))
      || compareStockFifo(a, b))
    for (const lot of compatibleStock) {
      const balance = remaining.get(lot.id) ?? 0
      const quantity = Math.min(needed, balance)
      if (quantity === 0) continue
      allocations.push({ demand, lot, quantity })
      remaining.set(lot.id, balance - quantity)
      needed -= quantity
      if (needed === 0) break
    }
    if (needed > 0) shortages.push({ demand, quantity: needed, reason: 'shortage' })
  }
  const moves = allocations.filter(({ demand, lot }) => demand.purpose && demand.purpose !== lot.purpose)
  const approvalKey = JSON.stringify(moves.map(({ demand, lot, quantity }) => [demand.taskId, demand.item.id, lot.id, lot.purpose, demand.purpose, quantity]))
  return { allocations, shortages, moves, approvalKey }
}

export function describeShortage({ demand, quantity, reason }: StockShortage): string {
  const coffee = `${demand.item.country} / ${demand.item.coffeeName}`
  switch (reason) {
    case 'unmatched': return `Не сопоставлен лот: ${coffee}`
    case 'ambiguous': return `Требуется выбрать лот: ${coffee}`
    case 'unsupported': return `Формат «${coffee}» не используется при сборке`
    case 'quantity': return `Недопустимое количество: ${coffee}`
    case 'shortage': return `Недостаточно стока${demand.name ? ` для «${demand.name}»` : ''}: ${coffee}, не хватает ${formatNumber(quantity)} шт.`
  }
}

export function compositionCapacity(items: CompositionItem[], inventory: InventoryLot[], otherDemands: StockDemand[] = []) {
  const matches = matchComposition(items, inventory)
  const valid = matches.length > 0 && matches.every((match) => match.matched && !match.ambiguous && Number.isSafeInteger(match.item.quantityPerSet) && match.item.quantityPerSet > 0 && isAssemblyFormat(match.item.formatId))
  let maximum = 0
  let limiting: StockMatch | undefined
  if (valid) {
    let upper = Math.min(...matches.map((match) => match.maxByItem))
    const forSets = (count: number) => matchDemands(items, count).concat(otherDemands)
    while (maximum < upper) {
      const target = maximum + Math.ceil((upper - maximum) / 2)
      if (allocateStock(forSets(target), inventory).shortages.length) upper = target - 1
      else maximum = target
    }
    const bottleneck = allocateStock(forSets(maximum + 1), inventory).shortages[0]
    limiting = matches.find((match) => match.item === bottleneck?.demand.item)
      ?? matches.reduce((lowest, match) => match.maxByItem < lowest.maxByItem ? match : lowest)
  }
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
