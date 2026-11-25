import { useState } from 'react'
import { Check, PackageCheck } from 'lucide-react'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { useSearchParams } from 'react-router'
import { useAppData } from '@/hooks/useAppData'
import { approveSchedule, markBU } from '@/persistence/actions'
import { coffeeDiscrepancy, formatNumber, kilograms, matchesTaskAllocation, remainingCoffee } from '@/domain/calculations'
import type { ProductionTask } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Empty, PageHeader } from '@/ui/components'

import { LotCard } from '@/ui/LotCard'

import { ProductionReceiptNotice, ProductionTaskDialog, type ProductionDialogMode, type ProductionReceipt } from '@/ui/ProductionTaskDialog'
import { QuickViewLink } from '@/ui/QuickViewLink'

export default function ProductionPage() {
  const data = useAppData()
  const { unlocked } = useAdmin()
  const [params, setParams] = useSearchParams()
  const directTaskId = params.get('task')
  const taskId = params.get('action') === 'produce' ? null : directTaskId
  const requestedRelease = params.get('action') === 'produce'
  const [selection, setSelection] = useState<{ taskId: string; mode: ProductionDialogMode }>()
  const [filter, setFilter] = useState('active')
  const [readiness, setReadiness] = useState('')
  const [formatId, setFormatId] = useState('')
  const [result, setResult] = useState<ProductionReceipt>()
  const today = format(new Date(), 'yyyy-MM-dd')
  const groupFor = (task: ProductionTask) => {
    if (task.status === 'cancelled') return 'cancelled'
    if (task.status === 'completed') return 'completed'
    return task.approved && task.plannedDate <= today && (task.scheduleDecision !== 'bu' || task.inBU) ? 'ready' : 'waiting'
  }
  const directTask = unlocked && directTaskId && requestedRelease && data.productionTasks.some((task) => task.id === directTaskId && groupFor(task) === 'ready')
    ? { taskId: directTaskId, mode: 'release' as const } : undefined
  const dialog = selection ?? directTask
  const closeDialog = () => {
    setSelection(undefined)
    if (requestedRelease) {
      const next = new URLSearchParams(params)
      next.delete('action')
      next.delete('task')
      setParams(next, { replace: true })
    }
  }

  const tasks = data.productionTasks
    .filter((task) => {
      if (taskId) return task.id === taskId
      if (formatId && task.formatId !== formatId) return false
      if (filter === 'all') return true
      if (filter === 'completed') return groupFor(task) === 'completed'
      return task.status === 'open' && (!readiness || groupFor(task) === readiness)
    })
    .sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))
  const tasksByLot = new Map<string, ProductionTask[]>()
  for (const task of tasks) {
    const lotTasks = tasksByLot.get(task.lotId)
    if (lotTasks) lotTasks.push(task)
    else tasksByLot.set(task.lotId, [task])
  }
  const listTitle = filter === 'active' ? 'Лоты в работе' : filter === 'completed' ? 'Лоты с завершёнными задачами' : 'Все лоты'

  return <>
    <PageHeader title="Производство" description="Назначения, сроки и выпуск по каждому лоту." action={taskId
      ? <Button variant="secondary" onClick={() => setParams({})}>Все задачи</Button>
      : undefined} />
    {!taskId && <div className="production-toolbar">
      <div className="tabs production-tabs" role="group" aria-label="Показать задачи">
        {[['active', 'Открытые'], ['completed', 'Завершённые'], ['all', 'Все задачи']].map(([value, label]) =>
          <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
      <div className="production-filters">
        {filter === 'active' && <label>Готовность<select className="field-control compact" value={readiness} onChange={(event) => setReadiness(event.target.value)}>
          <option value="">Все открытые</option><option value="ready">Готовые</option><option value="waiting">Ожидающие</option>
        </select></label>}
        <label>Формат<select className="field-control compact" value={formatId} onChange={(event) => setFormatId(event.target.value)}>
          <option value="">Все форматы</option>{data.settings.formats.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
      </div>
    </div>}
    {result && <ProductionReceiptNotice receipt={result} />}
    {!tasks.length && <Empty title="Задач нет" text={taskId ? 'Задача недоступна. Откройте общий список.' : 'Выберите другую группу или добавьте лот с назначениями.'} />}
    {tasks.length > 0 && <section aria-labelledby="production-lots">
      <div className="lot-list-heading"><h2 id="production-lots">{taskId ? 'Задача производства' : listTitle}</h2>{!taskId && <span>{tasksByLot.size}</span>}</div>
      <div className="lot-panel-list">{Array.from(tasksByLot, ([lotId, items]) => {
        const lot = data.lots.find((item) => item.id === lotId)
        const lotAllocations = data.allocations.filter((item) => item.lotId === lotId)
        const position = (task: ProductionTask) => lotAllocations.reduce((earliest, item) =>
          matchesTaskAllocation(task, item) ? Math.min(earliest, item.position ?? earliest) : earliest, Number.MAX_SAFE_INTEGER)
        items.sort((a, b) => a.plannedDate.localeCompare(b.plannedDate) || position(a) - position(b))
        return <LotCard key={lotId} lotId={lot?.id} title={lot ? `${lot.country} / ${lot.name}` : 'Производственная задача'}
          subtitle={lot ? `Вес лота ${kilograms(lot.weightKg)}` : undefined}>
          {items.map((task) => {
            const status = groupFor(task)
            const showRelease = status === 'ready' || Boolean(taskId)
            const formatDef = data.settings.formats.find((item) => item.id === task.formatId)
            const allocations = lotAllocations.filter((item) => matchesTaskAllocation(task, item))
            const entries = data.productionEntries.filter((item) => item.taskId === task.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            const remainder = formatDef ? remainingCoffee(task, formatDef, entries) : 0
            const discrepancy = formatDef ? coffeeDiscrepancy(task, formatDef, entries) : false
            const open = task.status === 'open'
            const responsible = data.employees.find((item) => item.id === task.responsibleId)
            const lastEntry = entries[0]
            const deductions = data.adjustments.filter((item) => item.entityType === 'production' && item.entityId === task.id)
            const purposes = [...new Set(allocations.map((item) => item.purpose))]
            return <div key={task.id} className="production-task">
              <div className="production-identity">
                <h4>{purposes.length === 1 && purposes[0] === 'СТМ' ? <span className="production-stm">СТМ</span> : purposes.join(' / ') || formatDef?.name || 'Назначение'}</h4>
                <p className="text-sm text-muted">{[formatDef?.name, kilograms(task.sourceWeightKg)].filter(Boolean).join(' · ')}</p>
              </div>
              <div className="production-state">
                <span className={status === 'ready' ? 'production-status is-ready' : 'production-status'}>
                  {status === 'completed' ? 'Завершено' : task.status === 'cancelled' ? 'Отменено' : status === 'ready' ? 'Готово к фасовке' : !task.approved ? 'Ждёт подтверждения' : 'Ожидает фасовки'}
                </span>
                {task.inBU && <Badge tone="warning">Находится в Б/у</Badge>}
                {unlocked && discrepancy && <Badge tone="warning">Расхождение расхода</Badge>}
              </div>
              <div className="production-date">
                <span>Изготовление</span>
                <time dateTime={task.plannedDate}>{format(parseISO(task.plannedDate), 'dd.MM.yyyy')}</time>
                {task.buDate && !task.inBU && <span>Б/у <time dateTime={task.buDate}>{format(parseISO(task.buDate), 'dd.MM.yyyy')}</time></span>}
              </div>
              <div className="production-balance">
                <span>Осталось</span>
                <strong>{formatNumber(open ? Math.max(0, task.plannedQuantity - task.producedQuantity) : 0)} шт.</strong>
              </div>
              {unlocked && open && <div className="production-actions">
                {open && task.scheduleDecision === 'bu' && task.approved && !task.inBU && <Button size="sm" variant="secondary" onClick={() => void markBU(task.id).then(() => toast.success('Отмечено: находится в Б/у')).catch((error) => toast.error(error.message))}>Запаковать в Б/у</Button>}
                {open && !task.approved && <Button size="sm" variant="secondary" onClick={() => void approveSchedule(task.id).then(() => toast.success(task.scheduleDecision === 'bu' ? 'Упаковка в Б/у согласована' : 'Дата подтверждена')).catch((error) => toast.error(error.message))}><Check size={16} aria-hidden="true" />{task.scheduleDecision === 'bu' ? 'Подтвердить упаковку в Б/у' : 'Подтвердить дату'}</Button>}
                {open && task.approved && (task.scheduleDecision !== 'bu' || task.inBU) && (showRelease ? <Button size="sm" onClick={() => setSelection({ taskId: task.id, mode: 'release' })}><PackageCheck size={16} aria-hidden="true" />Внести выпуск</Button>
                  : <QuickViewLink className="button button-secondary button-sm" to={`/production?task=${encodeURIComponent(task.id)}`}>Открыть задачу</QuickViewLink>)}

              </div>}
              <details className="production-details">
                <summary>Подробности задачи</summary>
                <dl className="production-numbers">
                  <div><dt>План</dt><dd>{formatNumber(task.plannedQuantity)} шт.</dd></div>
                  <div><dt>Факт</dt><dd>{formatNumber(task.producedQuantity)} шт.</dd></div>
                  <div><dt>Осталось кофе</dt><dd>≈ {kilograms(remainder)}</dd></div>
                </dl>
                <div className="text-sm text-muted">
                  {responsible && <p>Ответственный: {responsible.lastName} {responsible.firstName}</p>}
                  {lastEntry && <p>Последний выпуск: {format(new Date(lastEntry.createdAt), 'dd.MM.yyyy HH:mm')}</p>}
                  {task.comment && <p>{task.comment}</p>}
                </div>
                {(entries.length > 0 || deductions.length > 0) && <div className="text-sm">
                  <h5>История операций</h5>
                  <ul className="mt-2 space-y-1">
                    {entries.map((entry) => {
                      const employee = data.employees.find((item) => item.id === entry.responsibleId)
                      return <li key={entry.id}>{format(new Date(entry.createdAt), 'dd.MM.yyyy HH:mm')} · Изготовлено {formatNumber(entry.quantity)} шт.{employee && ` · ${employee.lastName} ${employee.firstName}`}{entry.comment && ` · ${entry.comment}`}</li>
                    })}
                    {deductions.map((entry) => <li key={entry.id}>{format(new Date(entry.createdAt), 'dd.MM.yyyy HH:mm')} · Списано {kilograms(entry.previousValue - entry.newValue)} · {entry.reason}</li>)}
                  </ul>
                </div>}
                {unlocked && remainder > 1e-9 && task.status !== 'cancelled' && <Button size="sm" variant="secondary" onClick={() => setSelection({ taskId: task.id, mode: 'writeoff' })}>Списать остаток</Button>}
              </details>
            </div>
          })}
        </LotCard>
      })}</div>
    </section>}
    {dialog && <ProductionTaskDialog key={dialog.taskId} taskId={dialog.taskId} initialMode={dialog.mode} onClose={closeDialog} onReceipt={setResult} />}
  </>
}
