import { useState, type FormEvent } from 'react'
import { Check, PackageCheck } from 'lucide-react'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { Link, useSearchParams } from 'react-router'
import { useAppData } from '@/hooks/useAppData'
import { approveSchedule, markBU, produce, writeOffProduction } from '@/persistence/repository'
import { coffeeDiscrepancy, formatNumber, remainingCoffee } from '@/domain/calculations'
import type { ProductionTask } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

import { LotCard } from '@/ui/LotCard'

const weightFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 })
const kilograms = (weight: number) => `${weightFormat.format(weight)} кг`
const inputWeight = (weight: number) => Number(weight.toFixed(12))
type Result = { taskId: string; received: number; remainder: number }

export default function ProductionPage() {
  const data = useAppData()
  const { unlocked } = useAdmin()
  const [params, setParams] = useSearchParams()
  const taskId = params.get('task')
  const [selected, setSelected] = useState<ProductionTask | null>(null)
  const [writeOff, setWriteOff] = useState<ProductionTask | null>(null)
  const [filter, setFilter] = useState('active')
  const [readiness, setReadiness] = useState('')
  const [formatId, setFormatId] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [quantity, setQuantity] = useState(1)
  const [employeeId, setEmployeeId] = useState('')
  const [comment, setComment] = useState('')
  const [weight, setWeight] = useState(0)
  const [reason, setReason] = useState('')
  const today = format(new Date(), 'yyyy-MM-dd')
  const groupFor = (task: ProductionTask) => {
    if (task.status === 'cancelled') return 'cancelled'
    if (task.status === 'completed') return 'completed'
    return task.approved && task.plannedDate <= today && (task.scheduleDecision !== 'bu' || task.inBU) ? 'ready' : 'waiting'
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!unlocked || !selected || busy) return
    setBusy(true)
    try {
      const { task, remainder, received } = await produce(selected.id, quantity, employeeId, comment)
      setResult({ taskId: task.id, received, remainder })
      setSelected(null)
      if (remainder > 1e-9) {
        setWriteOff(task)
        setWeight(inputWeight(remainder))
        setReason('')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения')
    } finally {
      setBusy(false)
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
    {result && <div className="notice release-result mb-5">
      <p role="status">На сток поступило <strong>{formatNumber(result.received)} шт.</strong> Остаток кофе после выпуска — <strong>{kilograms(result.remainder)}</strong>.</p>
      <Link className="button button-secondary button-sm" to={`/inventory?task=${encodeURIComponent(result.taskId)}`}>Открыть партии на стоке</Link>
    </div>}
    {!tasks.length && <Empty title="Задач нет" text={taskId ? 'Задача недоступна. Откройте общий список.' : 'Выберите другую группу или добавьте лот с назначениями.'} />}
    {tasks.length > 0 && <section aria-labelledby="production-lots">
      <div className="lot-list-heading"><h2 id="production-lots">{taskId ? 'Задача производства' : listTitle}</h2>{!taskId && <span>{tasksByLot.size}</span>}</div>
      <div className="lot-panel-list">{Array.from(tasksByLot, ([lotId, items]) => {
        const lot = data.lots.find((item) => item.id === lotId)
        const lotAllocations = data.allocations.filter((item) => item.lotId === lotId)
        const position = (task: ProductionTask) => lotAllocations.reduce((earliest, item) =>
          item.formatId === task.formatId ? Math.min(earliest, item.position ?? earliest) : earliest, Number.MAX_SAFE_INTEGER)
        items.sort((a, b) => a.plannedDate.localeCompare(b.plannedDate) || position(a) - position(b))
        return <LotCard key={lotId} lotId={lot?.id} title={lot ? `${lot.country} / ${lot.name}` : 'Производственная задача'}
          subtitle={lot ? `Вес лота ${kilograms(lot.weightKg)}` : undefined}>
          {items.map((task) => {
            const status = groupFor(task)
            const showRelease = status === 'ready' || Boolean(taskId)
            const formatDef = data.settings.formats.find((item) => item.id === task.formatId)
            const allocations = lotAllocations.filter((item) => item.formatId === task.formatId)
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
                {open && task.approved && (task.scheduleDecision !== 'bu' || task.inBU) && (showRelease ? <Button size="sm" onClick={() => {
                  setSelected(task)
                  setQuantity(1)
                  setComment('')
                  setEmployeeId(data.employees.find((item) => item.id === task.responsibleId && item.active)?.id ?? data.employees.find((item) => item.active)?.id ?? '')
                }}><PackageCheck size={16} aria-hidden="true" />Внести выпуск</Button>
                  : <Link className="button button-secondary button-sm" to={`/production?task=${encodeURIComponent(task.id)}`}>Открыть задачу</Link>)}

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
                {unlocked && remainder > 1e-9 && task.status !== 'cancelled' && <Button size="sm" variant="secondary" onClick={() => {
                  setWriteOff(task); setWeight(inputWeight(remainder)); setReason('')
                }}>Списать остаток</Button>}
              </details>
            </div>
          })}
        </LotCard>
      })}</div>
    </section>}
    {unlocked && selected && <Modal title="Внести выпуск" onClose={() => { if (!busy) setSelected(null) }}>
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Фактическое количество, шт."><Input autoFocus type="number" min="1" step="1" required value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></Field>
        <Field label="Ответственный"><select required className="field-control" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
          <option value="">Выберите сотрудника</option>{data.employees.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.lastName} {item.firstName}</option>)}
        </select></Field>
        <Field label="Комментарий"><Textarea value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
        <Button disabled={busy}>Отправить на сток</Button>
      </form>
    </Modal>}
    {unlocked && writeOff && <Modal title="Списать остаток кофе?" onClose={() => { if (!busy) setWriteOff(null) }}>
      <form className="grid gap-4" onSubmit={async (event) => {
        event.preventDefault()
        if (!unlocked || busy) return
        setBusy(true)
        try {
          await writeOffProduction(writeOff.id, weight, reason)
          toast.success('Списание сохранено')
          setWriteOff(null)
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Ошибка')
        } finally {
          setBusy(false)
        }
      }}>
        {result?.taskId === writeOff.id && <p className="notice">На сток поступило {formatNumber(result.received)} шт. Осталось {kilograms(result.remainder)}.</p>}
        <p className="text-sm text-muted">Если списать весь остаток, задача перейдёт в завершённые.</p>
        <Field label="Вес, кг"><Input type="number" min="0.000000001" step="any" required value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></Field>
        <Field label="Причина"><Textarea required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Например: технологический остаток" /></Field>
        <div className="modal-actions"><Button disabled={busy} type="button" variant="ghost" onClick={() => setWriteOff(null)}>Не списывать</Button><Button disabled={busy} variant="danger">Подтвердить списание</Button></div>
      </form>
    </Modal>}
  </>
}
