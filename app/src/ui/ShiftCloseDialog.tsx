import { useState, type FormEvent } from 'react'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import type { ShiftCloseDecision } from '@/domain/assemblyReports'
import { nextShiftDate } from '@/domain/calendar'
import { allocateStock, describeShortage, formatNumber, taskDemands } from '@/domain/calculations'
import type { AppData } from '@/hooks/useAppData'
import { closeProductionDay, tasksToTransfer } from '@/persistence/repository'
import { AssemblyParticipants } from './AssemblyParticipants'
import { Button, Field, Input, Modal } from './components'

interface TaskReview {
  transfer: boolean
  mode: '' | 'zero' | 'positive'
  quantity: string
  participantIds: string[]
}

const defaultReview: TaskReview = { transfer: true, mode: '', quantity: '', participantIds: [] }

export function ShiftCloseDialog({ date, data, onClose }: { date: string; data: AppData; onClose: () => void }) {
  const [reviews, setReviews] = useState<Record<string, TaskReview>>({})
  const [busy, setBusy] = useState(false)
  const tasks = tasksToTransfer(data.assemblyTasks, date)
  const reports = data.assemblyReports.filter(({ productionDate }) => productionDate === date)
  const reported = new Set(reports.map(({ taskId }) => taskId))
  const notes = reports.filter(({ comment }) => comment?.trim())
  const warnings = data.warnings.filter(({ read }) => !read)
  const draftIssues = data.assemblyPlans.filter(({ status, date: planDate }) => status === 'draft' && planDate <= date).flatMap((plan) => {
    const pending = data.assemblyTasks.filter(({ planId, status }) => planId === plan.id && status === 'pending')
    const preview = allocateStock(taskDemands(pending), data.inventory)
    return [
      ...preview.shortages.map(describeShortage),
      ...preview.moves.map(({ lot, demand, quantity }) => `${lot.country} / ${lot.coffeeName} · ${lot.purpose} → ${demand.purpose} · ${formatNumber(quantity)} шт.`),
    ]
  })
  let nextDate = ''
  try { nextDate = nextShiftDate(date, data.settings) } catch { /* The dialog explains the calendar error. */ }

  function update(taskId: string, change: Partial<TaskReview>) {
    setReviews((current) => ({ ...current, [taskId]: { ...(current[taskId] ?? defaultReview), ...change } }))
  }

  const rows = tasks.map((task) => {
    const review = reviews[task.id] ?? defaultReview
    const hasReport = reported.has(task.id)
    const remaining = task.plannedQuantity - task.completedQuantity
    const quantity = Number(review.quantity)
    const validPositive = Number.isSafeInteger(quantity) && quantity > 0 && quantity <= remaining &&
      review.participantIds.length >= (task.jointAssembly ? 2 : 1)
    const fact = hasReport ? undefined : review.mode === 'zero' ? { quantity: 0, participantIds: [] }
      : review.mode === 'positive' && validPositive ? { quantity, participantIds: review.participantIds } : undefined
    return { task, review, hasReport, remaining, fact }
  })
  const ready = Boolean(nextDate) && rows.every((row) => row.hasReport || row.fact)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || busy) return
    const decisions: ShiftCloseDecision[] = rows.map(({ task, review, fact }) => ({
      taskId: task.id, completedQuantity: task.completedQuantity, transfer: review.transfer, fact,
    }))
    setBusy(true)
    try {
      await closeProductionDay(date, decisions)
      toast.success('День завершён, отчёт сохранён в архив')
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось завершить смену')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title="Завершить производственный день?" onClose={() => { if (!busy) onClose() }} wide>
    <form className="grid gap-4" onSubmit={submit}>
      {!nextDate && <p role="alert" className="notice">В ближайшие 45 дней нет рабочего дня. Проверьте настройки календаря.</p>}
      {tasks.length > 0 ? <section>
        <h3 className="mb-2 font-semibold">{nextDate ? `Перенос на ${format(parseISO(nextDate), 'dd.MM.yyyy')}` : 'Остатки заданий'}</h3>
        <p className="mb-3 text-sm text-muted">Снимите отметку, чтобы освободить резерв остатка при закрытии.</p>
        <div className="grid gap-3">{rows.map(({ task, review, hasReport, remaining, fact }) => {
          const left = remaining - (fact?.quantity ?? 0)
          return <fieldset key={task.id} className="min-w-0 rounded-lg border border-border p-4">
            <legend className="max-w-full break-words px-1 font-semibold">{task.name}</legend>
            {!hasReport && <div className="mb-3 grid gap-3">
              <Field label="Факт за эту смену">
                <select className="field-control" value={review.mode} required onChange={(event) => update(task.id, { mode: event.target.value as TaskReview['mode'] })}>
                  <option value="">Выберите, что собрали</option>
                  <option value="positive">Внести собранные наборы</option>
                  <option value="zero">Подтвердить нулевой факт</option>
                </select>
              </Field>
              {review.mode === 'positive' && <>
                <AssemblyParticipants employees={data.employees} joint={task.jointAssembly} selected={review.participantIds}
                  onChange={(participantIds) => update(task.id, { participantIds })} />
                <Field label="Фактически собрано наборов">
                  <Input type="number" min="1" max={remaining} step="1" required value={review.quantity}
                    onChange={(event) => update(task.id, { quantity: event.target.value })} />
                </Field>
              </>}
            </div>}
            <p className="mb-1 text-sm text-muted">Остаток задания {formatNumber(left)} наб.</p>
            {left > 0 && <label className="check-filter min-h-9">
              <input type="checkbox" checked={review.transfer} onChange={(event) => update(task.id, { transfer: event.target.checked })} />
              Перенести на следующий рабочий день
            </label>}
          </fieldset>
        })}</div>
      </section> : <p>Заданий к переносу нет.</p>}
      {draftIssues.length > 0 && <section><h3 className="mb-2 font-semibold">Проверка черновиков</h3><ul className="grid gap-2">{draftIssues.map((issue, index) => <li key={index} className="notice">{issue}</li>)}</ul></section>}
      {notes.length > 0 && <section><h3 className="mb-2 font-semibold">Комментарии сборщиков</h3><ul className="grid gap-2">{notes.map(({ id, comment }) => <li key={id}>{comment}</li>)}</ul></section>}
      {warnings.length > 0 && <section><h3 className="mb-2 font-semibold">Предупреждения</h3><ul className="grid gap-2">{warnings.map(({ id, message }) => <li className="notice" key={id}>{message}</li>)}</ul></section>}
      <div className="modal-actions">
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Вернуться</Button>
        <Button disabled={busy || !ready}>Подтвердить завершение</Button>
      </div>
    </form>
  </Modal>
}
