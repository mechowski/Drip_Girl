import { format } from 'date-fns'
import { formatNumber } from '@/domain/calculations'
import type { AppData } from '@/hooks/useAppData'

export type ShiftCalendarEntry = {
  id: string
  title: string
  group: string
  label: string
  detail: string
  quantity?: string
  canProduce?: boolean
  to: string
  kind: 'production' | 'assembly' | 'degassing' | 'packing'
}

export function buildShiftCalendarEntries(data: AppData, unlocked: boolean, includeMilestones = false) {
  const today = format(new Date(), 'yyyy-MM-dd')
  const days = new Map<string, ShiftCalendarEntry[]>()
  const lotNames = new Map(data.lots.map((lot) => [lot.id, `${lot.country} / ${lot.name}`]))
  const formats = new Map(data.settings.formats.map(({ id, name }) => [id, name]))

  function add(date: string, entry: ShiftCalendarEntry) {
    const entries = days.get(date)
    if (entries) entries.push(entry)
    else days.set(date, [entry])
  }

  for (const task of data.productionTasks) {
    if (task.status === 'cancelled') continue
    const title = lotNames.get(task.lotId) ?? 'Производственная задача'
    const to = `/production?task=${encodeURIComponent(task.id)}`
    const group = `lot-${task.lotId}`
    const formatName = formats.get(task.formatId)
    const designation = [task.purpose, formatName].filter(Boolean).join(' · ') || 'Обычный выпуск'
    const needsPacking = task.scheduleDecision === 'bu' && !task.inBU
    const ready = task.status === 'open' && task.approved && !needsPacking && task.plannedDate <= today
    const canProduce = ready && unlocked
    const status = task.status === 'completed' ? 'Завершено' : !task.approved ? 'Ждёт подтверждения'
      : needsPacking ? 'Ждёт упаковки в Б/у' : ready ? 'Готово к фасовке' : 'Запланировано'
    const quantity = ready ? Math.max(0, task.plannedQuantity - task.producedQuantity) : task.plannedQuantity
    add(task.plannedDate, {
      id: `produce-${task.id}`, title, group, label: designation, kind: 'production', canProduce,
      to: canProduce ? `${to}&action=produce` : to,
      detail: status, quantity: `${formatNumber(quantity)} шт.`,
    })
    if (!includeMilestones) continue
    if (task.readyDate !== task.plannedDate) {
      add(task.readyDate, { id: `ready-${task.id}`, title, group, to, label: designation, kind: 'degassing', detail: 'Окончание дегазации' })
    }
    if (task.buDate) {
      add(task.buDate, { id: `pack-${task.id}`, title, group, to, label: designation, kind: 'packing', detail: task.inBU ? 'Упаковано в Б/у' : 'Упаковка в Б/у' })
    }
  }

  for (const task of data.assemblyTasks) {
    const draft = task.status === 'draft' || task.status === 'pending'
    if (task.status === 'cancelled' || (draft && !unlocked)) continue
    add(task.productionDate, {
      id: `assembly-${task.id}`, title: task.name, group: `assembly-${task.id}`, label: 'Сборка', kind: 'assembly',
      detail: draft ? 'Черновик' : task.status === 'completed' ? 'Завершено' : 'План смены',
      quantity: `${formatNumber(task.plannedQuantity)} наб.`,
      to: draft ? `/assembly#plan-${task.planId}` : `/assembly#task-${task.id}`,
    })
  }
  return days
}
