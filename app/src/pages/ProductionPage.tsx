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
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

const weightFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 })
const kilograms = (weight: number) => `${weightFormat.format(weight)} кг`
const inputWeight = (weight: number) => Number(weight.toFixed(12))
type Result = { taskId: string; received: number; remainder: number }

export default function ProductionPage() {
  const data = useAppData()
  const { unlocked, requestUnlock } = useAdmin()
  const [params, setParams] = useSearchParams()
  const taskId = params.get('task')
  const [selected, setSelected] = useState<ProductionTask | null>(null)
  const [writeOff, setWriteOff] = useState<ProductionTask | null>(null)
  const [filter, setFilter] = useState('active')
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [quantity, setQuantity] = useState(1)
  const [employeeId, setEmployeeId] = useState('')
  const [comment, setComment] = useState('')
  const [weight, setWeight] = useState(0)
  const [reason, setReason] = useState('')
  const today = format(new Date(), 'yyyy-MM-dd')
  const adminAction = (action: () => void) => { if (!unlocked) requestUnlock(); else action() }
  const groupFor = (task: ProductionTask) => {
    if (task.status === 'completed') return 'completed'
    return task.approved && task.plannedDate <= today && (task.scheduleDecision !== 'bu' || task.inBU) ? 'ready' : 'waiting'
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected || busy) return
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
    .filter((task) => taskId ? task.id === taskId : filter === 'all' || (filter === 'active' ? task.status === 'open' : groupFor(task) === filter))
    .sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))
  const groups = [
    { id: 'ready', title: 'Готово к работе' },
    { id: 'waiting', title: 'Ожидают' },
    { id: 'completed', title: 'Завершённые' },
  ]

  return <>
    <div className="production-heading">
      <PageHeader title="Производство" description="План, выпуск и остаток кофе по каждой задаче" action={taskId
        ? <Button variant="secondary" onClick={() => setParams({})}>Все задачи</Button>
        : <select aria-label="Показать задачи" className="field-control" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="active">Открытые</option><option value="ready">Готовые</option><option value="waiting">Ожидающие</option>
          <option value="completed">Завершённые</option><option value="all">Все задачи</option>
        </select>} />
    </div>
    {result && <div className="notice release-result mb-5">
      <p role="status">На сток поступило <strong>{formatNumber(result.received)} шт.</strong> Остаток кофе после выпуска — <strong>{kilograms(result.remainder)}</strong>.</p>
      <Link className="button button-secondary button-sm" to={`/inventory?task=${encodeURIComponent(result.taskId)}`}>Открыть партии на стоке</Link>
    </div>}
    {!tasks.length && <Empty title="Задач нет" text={taskId ? 'Задача недоступна. Откройте общий список.' : 'Выберите другую группу или добавьте лот с назначениями.'} />}
    {groups.map(({ id, title }) => {
      const items = tasks.filter((task) => groupFor(task) === id)
      if (!items.length) return null
      return <section className="mb-6" key={id} aria-labelledby={`production-${id}`}>
        <div className="section-title"><h2 id={`production-${id}`}>{title}</h2><span>{items.length}</span></div>
        <div className="grid gap-3">{items.map((task) => {
          const lot = data.lots.find((item) => item.id === task.lotId)
          const formatDef = data.settings.formats.find((item) => item.id === task.formatId)
          const allocations = data.allocations.filter((item) => item.lotId === task.lotId && item.formatId === task.formatId)
          const entries = data.productionEntries.filter((item) => item.taskId === task.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          const remainder = formatDef ? remainingCoffee(task, formatDef, entries) : 0
          const discrepancy = formatDef ? coffeeDiscrepancy(task, formatDef, entries) : false
          const open = task.status === 'open'
          const responsible = data.employees.find((item) => item.id === task.responsibleId)
          const lastEntry = entries[0]
          const deductions = data.adjustments.filter((item) => item.entityType === 'production' && item.entityId === task.id)
          return <Card key={task.id} className="production-task">
            <div className="production-identity">
              <h3 className="card-title">{lot ? `${lot.country} / ${lot.name}` : 'Производственная задача'}</h3>
              <p className="text-sm text-muted">{[formatDef?.name, ...new Set(allocations.map((item) => item.purpose))].filter(Boolean).join(' / ')}</p>
              <p className="text-sm text-muted">Изготовление <time dateTime={task.plannedDate}>{format(parseISO(task.plannedDate), 'dd.MM.yyyy')}</time></p>
              {task.buDate && !task.inBU && <p className="text-sm text-muted">Упаковка в Б/у <time dateTime={task.buDate}>{format(parseISO(task.buDate), 'dd.MM.yyyy')}</time></p>}
            </div>
            <div className="production-state">
              <Badge tone={id === 'waiting' ? 'warning' : 'success'}>{id === 'completed' ? 'Завершено' : id === 'ready' ? 'Готово к фасовке' : !task.approved ? 'Ждёт подтверждения' : 'Ожидает фасовки'}</Badge>
              {task.inBU && <Badge tone="warning">Находится в Б/у</Badge>}
              {discrepancy && <Badge tone="warning">Расхождение расхода</Badge>}
            </div>
            <dl className="production-numbers">
              <div><dt>План</dt><dd>{formatNumber(task.plannedQuantity)} шт.</dd></div>
              <div><dt>Факт</dt><dd>{formatNumber(task.producedQuantity)} шт.</dd></div>
              <div><dt>Остаток задачи</dt><dd>{formatNumber(open ? Math.max(0, task.plannedQuantity - task.producedQuantity) : 0)} шт.</dd></div>
              <div><dt>Исходный вес</dt><dd>{kilograms(task.sourceWeightKg)}</dd></div>
              <div><dt>Осталось кофе</dt><dd>≈ {kilograms(remainder)}</dd></div>
            </dl>
            {(open || remainder > 1e-9) && <div className="production-actions">
              {open && task.scheduleDecision === 'bu' && task.approved && !task.inBU && <Button size="sm" variant="secondary" onClick={() => adminAction(() => markBU(task.id).then(() => toast.success('Отмечено: находится в Б/у')).catch((error) => toast.error(error.message)))}>Запаковать в Б/у</Button>}
              {open && !task.approved && <Button size="sm" variant="secondary" onClick={() => adminAction(() => approveSchedule(task.id).then(() => toast.success(task.scheduleDecision === 'bu' ? 'Упаковка в Б/у согласована' : 'Дата подтверждена')).catch((error) => toast.error(error.message)))}><Check size={16} aria-hidden="true" />{task.scheduleDecision === 'bu' ? 'Подтвердить упаковку в Б/у' : 'Подтвердить дату'}</Button>}
              {open && task.approved && (task.scheduleDecision !== 'bu' || task.inBU) && <Button size="sm" onClick={() => adminAction(() => {
                setSelected(task)
                setQuantity(1)
                setComment('')
                setEmployeeId(data.employees.find((item) => item.id === task.responsibleId && item.active)?.id ?? data.employees.find((item) => item.active)?.id ?? '')
              })}><PackageCheck size={16} aria-hidden="true" />Внести выпуск</Button>}
              {remainder > 1e-9 && task.status !== 'cancelled' && <Button size="sm" variant="ghost" onClick={() => adminAction(() => {
                setWriteOff(task); setWeight(inputWeight(remainder)); setReason('')
              })}>Списать остаток</Button>}
            </div>}
            {(responsible || lastEntry || task.comment) && <div className="production-comment text-sm text-muted">
              {responsible && <p>Ответственный: {responsible.lastName} {responsible.firstName}</p>}
              {lastEntry && <p>Последний выпуск: {format(new Date(lastEntry.createdAt), 'dd.MM.yyyy HH:mm')}</p>}
              {task.comment && <p>{task.comment}</p>}
            </div>}
            {(entries.length > 0 || deductions.length > 0) && <details className="production-comment text-sm text-muted">
              <summary className="cursor-pointer">История операций</summary>
              <ul className="mt-2 space-y-1">
                {entries.map((entry) => {
                  const employee = data.employees.find((item) => item.id === entry.responsibleId)
                  return <li key={entry.id}>{format(new Date(entry.createdAt), 'dd.MM.yyyy HH:mm')} · Изготовлено {formatNumber(entry.quantity)} шт.{employee && ` · ${employee.lastName} ${employee.firstName}`}{entry.comment && ` · ${entry.comment}`}</li>
                })}
                {deductions.map((entry) => <li key={entry.id}>{format(new Date(entry.createdAt), 'dd.MM.yyyy HH:mm')} · Списано {kilograms(entry.previousValue - entry.newValue)} · {entry.reason}</li>)}
              </ul>
            </details>}
          </Card>
        })}</div>
      </section>
    })}
    {selected && <Modal title="Внести выпуск" onClose={() => { if (!busy) setSelected(null) }}>
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Фактическое количество, шт."><Input autoFocus type="number" min="1" step="1" required value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></Field>
        <Field label="Ответственный"><select required className="field-control" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
          <option value="">Выберите сотрудника</option>{data.employees.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.lastName} {item.firstName}</option>)}
        </select></Field>
        <Field label="Комментарий"><Textarea value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
        <Button disabled={busy}>Отправить на сток</Button>
      </form>
    </Modal>}
    {writeOff && <Modal title="Списать остаток кофе?" onClose={() => { if (!busy) setWriteOff(null) }}>
      <form className="grid gap-4" onSubmit={async (event) => {
        event.preventDefault()
        if (busy) return
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
