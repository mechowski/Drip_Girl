import { useState, type FormEvent } from 'react'
import { format, parseISO } from 'date-fns'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { formatNumber, kilograms, matchesTaskAllocation, remainingCoffee } from '@/domain/calculations'
import { useAppData } from '@/hooks/useAppData'
import { approveSchedule, markBU, produce, writeOffProduction } from '@/persistence/repository'
import { useAdmin } from './AdminContext'
import { Button, Field, Input, Modal, Textarea } from './components'

export type ProductionDialogMode = 'details' | 'release' | 'writeoff'
export type ProductionReceipt = { taskId: string; received: number; remainder: number; label: string }

export function ProductionReceiptNotice({ receipt }: { receipt: ProductionReceipt }) {
  return <div className="notice release-result mb-5">
    <p role="status">На сток поступило <strong>{formatNumber(receipt.received)} шт.</strong> Остаток кофе после выпуска — <strong>{kilograms(receipt.remainder)}</strong>. <span className="block text-sm">{receipt.label}</span></p>
    <Link className="button button-secondary button-sm" to={`/inventory?task=${encodeURIComponent(receipt.taskId)}`}>Открыть партии на стоке</Link>
  </div>
}

export function ProductionTaskDialog({ taskId, initialMode, onClose, onReceipt }: {
  taskId: string; initialMode: ProductionDialogMode; onClose: () => void; onReceipt: (receipt: ProductionReceipt) => void
}) {
  const data = useAppData()
  const { unlocked } = useAdmin()
  const [mode, setMode] = useState(initialMode)
  const [quantity, setQuantity] = useState('')
  const [employeeId, setEmployeeId] = useState<string>()
  const [comment, setComment] = useState('')
  const [weight, setWeight] = useState<number>()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<ProductionReceipt>()
  const task = data.productionTasks.find(({ id }) => id === taskId)
  if (!task) return <Modal title="Задача производства" onClose={onClose}><p>Эта задача недоступна.</p></Modal>

  const lot = data.lots.find(({ id }) => id === task.lotId)
  const formatDef = data.settings.formats.find(({ id }) => id === task.formatId)
  const entries = data.productionEntries.filter((entry) => entry.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const purposes = task.purpose ?? [...new Set(data.allocations.filter((item) => item.lotId === task.lotId && matchesTaskAllocation(task, item)).map(({ purpose }) => purpose))].join(' / ')
  const lotLabel = lot ? `${lot.country} / ${lot.name}` : 'Лот'
  const designation = [formatDef?.name, purposes].filter(Boolean).join(' · ')
  const remaining = Math.max(0, task.plannedQuantity - task.producedQuantity)
  const remainingWeight = formatDef ? remainingCoffee(task, formatDef, entries) : 0
  const open = task.status === 'open'
  const needsPacking = task.scheduleDecision === 'bu' && !task.inBU
  const canRelease = unlocked && open && task.approved && !needsPacking && Boolean(formatDef)
  const canWriteOff = unlocked && task.status !== 'cancelled' && remainingWeight > 1e-9
  const displayMode = mode === 'release' && !canRelease || mode === 'writeoff' && !unlocked ? 'details' : mode
  const employees = data.employees.filter(({ active }) => active)
  const selectedEmployee = employeeId ?? employees.find(({ id }) => id === task.responsibleId)?.id ?? employees[0]?.id ?? ''
  const showWeight = weight ?? Number(remainingWeight.toFixed(12))

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try { await action() }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Не удалось выполнить операцию') }
    finally { setBusy(false) }
  }

  function submitRelease(event: FormEvent) {
    event.preventDefault()
    if (!canRelease) return
    void run(async () => {
      const { received, remainder } = await produce(taskId, Number(quantity), selectedEmployee, comment)
      const result = { taskId, received, remainder, label: [lotLabel, designation].filter(Boolean).join(' · ') }
      onReceipt(result)
      if (remainder > 1e-9) {
        setReceipt(result)
        setWeight(Number(remainder.toFixed(12)))
        setMode('writeoff')
      } else onClose()
    })
  }

  return <Modal title={displayMode === 'release' ? 'Внести выпуск' : displayMode === 'writeoff' ? 'Списать остаток кофе?' : 'Задача производства'}
    onClose={() => { if (!busy) onClose() }}>
    <div className="grid gap-4">
      <section className="task-dialog-summary" aria-label="Выбранная задача">
        <h3>{lotLabel}</h3>
        <p>{designation}{designation && ' · '}Обжарка {lot ? format(parseISO(lot.roastDate), 'dd.MM.yyyy') : '—'}</p>
        <p>Изготовление {format(parseISO(task.plannedDate), 'dd.MM.yyyy')}{needsPacking && task.buDate && ` · Б/у ${format(parseISO(task.buDate), 'dd.MM.yyyy')}`}</p>
        <dl>
          <div><dt>План</dt><dd>{formatNumber(task.plannedQuantity)} шт.</dd></div>
          <div><dt>Выпущено</dt><dd>{formatNumber(task.producedQuantity)} шт.</dd></div>
          <div><dt>Осталось по плану</dt><dd>{formatNumber(remaining)} шт.</dd></div>
          <div><dt>Осталось кофе</dt><dd>{kilograms(remainingWeight)}</dd></div>
        </dl>
      </section>
      {displayMode === 'release' && <form className="grid gap-4" onSubmit={submitRelease}>
        <Field label="Фактическое количество, шт."><Input autoFocus type="number" min="1" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
        <Field label="Ответственный"><select required className="field-control" value={selectedEmployee} onChange={(event) => setEmployeeId(event.target.value)}>
          <option value="">Выберите сотрудника</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.lastName} {item.firstName}</option>)}
        </select></Field>
        {!employees.length && <p className="text-sm text-muted">Добавьте активного сотрудника, чтобы внести выпуск.</p>}
        <Field label="Комментарий"><Textarea value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
        <Button disabled={busy || !employees.length}>Отправить на сток</Button>
      </form>}
      {displayMode === 'writeoff' && <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault()
        if (!canWriteOff) return
        void run(async () => { await writeOffProduction(taskId, showWeight, reason); toast.success('Списание сохранено'); onClose() })
      }}>
        {receipt && <p className="notice">На сток поступило {formatNumber(receipt.received)} шт. Осталось {kilograms(receipt.remainder)}.</p>}
        <p className="text-sm text-muted">Если списать весь остаток, задача перейдёт в завершённые.</p>
        <Field label="Вес, кг"><Input type="number" min="0.000000001" step="any" required value={showWeight} onChange={(event) => setWeight(Number(event.target.value))} /></Field>
        <Field label="Причина"><Textarea required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Например: технологический остаток" /></Field>
        <div className="modal-actions"><Button disabled={busy} type="button" variant="ghost" onClick={onClose}>Не списывать</Button><Button disabled={busy || !canWriteOff} variant="danger">Подтвердить списание</Button></div>
      </form>}
      {displayMode === 'details' && <>
        {task.comment && <p className="text-sm">{task.comment}</p>}
        {entries.length > 0 && <details><summary className="cursor-pointer">История выпусков</summary>
          <ul className="shift-day-plan">{entries.map((entry) => <li key={entry.id}>{format(new Date(entry.createdAt), 'dd.MM.yyyy HH:mm')} · {formatNumber(entry.quantity)} шт.{entry.comment && ` · ${entry.comment}`}</li>)}</ul>
        </details>}
        {unlocked && <div className="modal-actions">
          {open && !task.approved && <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await approveSchedule(taskId); toast.success('Дата подтверждена') })}>{needsPacking ? 'Подтвердить упаковку в Б/у' : 'Подтвердить дату'}</Button>}
          {open && task.approved && needsPacking && <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { await markBU(taskId); toast.success('Отмечено: находится в Б/у') })}>Запаковать в Б/у</Button>}
          {canWriteOff && <Button variant="secondary" onClick={() => setMode('writeoff')}>Списать остаток</Button>}
          {canRelease && <Button onClick={() => setMode('release')}>Внести выпуск</Button>}
        </div>}
      </>}
    </div>
  </Modal>
}
