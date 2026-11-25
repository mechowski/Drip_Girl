import { allocateStock, exactCoffeeKey, isPrivateLabel, matchComposition, matchesTaskAllocation, plannedOutput, remainingCoffee, splitProductionReceipt, taskDemands } from './calculations'
import type { AppSettings, AssemblyTask, CoffeeLot, ExpectedReservation, InventoryLot, LotAllocation, ProductionDay, ProductionEntry, ProductionTask } from './types'

interface OutputData {
  lots: CoffeeLot[]
  allocations: LotAllocation[]
  productionTasks: ProductionTask[]
  productionEntries: ProductionEntry[]
  expectedReservations: ExpectedReservation[]
  productionDays: ProductionDay[]
  settings: AppSettings
  inventory: InventoryLot[]
}

function plannedProductionOutput(task: ProductionTask, settings: AppSettings, allocations: LotAllocation[], entries: ProductionEntry[]) {
  const format = settings.formats.find(({ id }) => id === task.formatId)
  if (!format) return {}
  const quantity = Math.min(task.plannedQuantity - task.producedQuantity, plannedOutput(remainingCoffee(task, format, entries), format.coefficient))
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return {}
  if (task.purpose !== undefined) return { [task.purpose]: quantity }
  const relevant = allocations.filter((row) => row.lotId === task.lotId && matchesTaskAllocation(task, row))
  return relevant.length ? splitProductionReceipt(quantity, relevant, task.coefficientSnapshot ?? entries[0]?.coefficientSnapshot ?? format.coefficient, task.producedQuantity, entries) : {}
}

export function fitsExpectedReservations(task: ProductionTask, settings: AppSettings, allocations: LotAllocation[], entries: ProductionEntry[], claims: ExpectedReservation[]) {
  const balances = plannedProductionOutput(task, settings, allocations, entries)
  for (const { purpose, quantity } of claims) {
    balances[purpose] = (balances[purpose] ?? 0) - quantity
    if (balances[purpose] < 0) return false
  }
  return true
}

const outputKey = (taskId: string, purpose: string) => JSON.stringify([taskId, purpose])

export function expectedOutput(data: OutputData, date: string): InventoryLot[] {
  if (data.productionDays.some((day) => day.date === date && day.status === 'closed')) return []
  const promised = new Map<string, number>()
  for (const row of data.expectedReservations) {
    const key = outputKey(row.productionTaskId, row.purpose)
    promised.set(key, (promised.get(key) ?? 0) + row.quantity)
  }
  const lots = new Map(data.lots.map((lot) => [lot.id, lot]))
  return data.productionTasks.flatMap((task) => {
    const lot = lots.get(task.lotId)
    if (!lot || task.plannedDate !== date || task.status !== 'open' || !task.approved || (task.scheduleDecision === 'bu' && !task.inBU)) return []
    const entries = data.productionEntries.filter((entry) => entry.taskId === task.id)
    return Object.entries(plannedProductionOutput(task, data.settings, data.allocations, entries)).flatMap(([purpose, planned]) => {
      const id = outputKey(task.id, purpose)
      const quantity = planned - (promised.get(id) ?? 0)
      if (quantity <= 0 || isPrivateLabel(purpose)) return []
      return [{
        id, sourceLotId: lot.id, productionTaskId: task.id, country: lot.country, coffeeName: lot.name,
        formatId: task.formatId, purpose, quantity, reserved: 0, shared: true, inBU: task.inBU,
        createdAt: task.createdAt, manufacturedAt: date, isDemo: task.isDemo,
      }]
    })
  })
}

export function previewAssemblyReservation(tasks: AssemblyTask[], data: OutputData, date: string, today: string) {
  const physical = allocateStock(taskDemands(tasks), data.inventory)
  const shortages = physical.shortages
  if (date !== today || !shortages.length || shortages.some(({ reason }) => reason !== 'shortage' && reason !== 'unmatched')) {
    return { physical, expected: [], shortages, approvalKey: undefined }
  }
  const identities = new Map<ReturnType<typeof taskDemands>[number], string>()
  const demands = shortages.map(({ demand, quantity }) => {
    const item = demand.item
    const first = item.inventoryLotId ? undefined : matchComposition([item], data.inventory)[0].lots[0]
    const entry = { ...demand, quantity, item: first ? { ...item, country: first.country, coffeeName: first.coffeeName } : item }
    // Preserve the coffee identity already selected for an unpinned ingredient on physical stock.
    if (first) identities.set(entry, exactCoffeeKey(first.country, first.coffeeName))
    return entry
  })
  const candidate = allocateStock(demands, expectedOutput(data, date))
  const conflicts = candidate.allocations.some(({ demand, lot }) => {
    const identity = identities.get(demand)
    return identity !== undefined && identity !== exactCoffeeKey(lot.country, lot.coffeeName)
  })
  if (candidate.shortages.length || conflicts) return { physical, expected: [], shortages, approvalKey: undefined }
  const expected = candidate.allocations
  const approvalKey = JSON.stringify(expected.map(({ demand, lot, quantity }) => [demand.taskId, demand.item.id, lot.id, quantity]))
  return { physical, expected, shortages: [], approvalKey }
}

export function reportedExpected(reservation: ExpectedReservation) {
  return reservation.reported.reduce((sum, row) => sum + row.quantity, 0)
}
