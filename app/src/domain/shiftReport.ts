import { exactCoffeeKey } from './calculations'
import type { AssemblyTask, DailyReport } from './types'

export function productionByLot(entries: DailyReport['produced']) {
  const lots = new Map<string, { quantity: number; byTask: Map<string, number> }>()
  for (const entry of entries) {
    const row = lots.get(entry.lotId) ?? { quantity: 0, byTask: new Map() }
    row.quantity += entry.quantity
    row.byTask.set(entry.taskId, (row.byTask.get(entry.taskId) ?? 0) + entry.quantity)
    lots.set(entry.lotId, row)
  }
  return [...lots].map(([lotId, row]) => ({ lotId, ...row }))
}

export function assemblyByComposition(rows: DailyReport['assembled'], tasks: AssemblyTask[]) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const compositions = new Map<string, {
    id: string
    name: string
    fact: number
    plan: number
    remaining: number
    comments: string[]
    items?: AssemblyTask['compositionSnapshot']
  }>()
  for (const row of rows) {
    const task = tasksById.get(row.taskId)
    const items = task?.compositionSnapshot
    const ingredients = items?.map((item) => JSON.stringify([
      item.inventoryLotId ?? exactCoffeeKey(item.country, item.coffeeName), item.formatId, item.quantityPerSet,
    ])).sort()
    const id = task ? JSON.stringify([task.compositionId, task.compositionKind, ingredients]) : row.taskId
    const total = compositions.get(id) ?? { id, name: row.name, fact: 0, plan: 0, remaining: 0, comments: [], items }
    total.fact += row.fact
    total.plan += row.plan
    if (row.disposition !== 'released') total.remaining += row.remaining
    total.comments.push(...row.comments)
    compositions.set(id, total)
  }
  return [...compositions.values()]
}
