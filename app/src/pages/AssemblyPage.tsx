import { assemblyParticipantNames } from '@/domain/assemblyReports'
import { canReportAssembly } from '@/ui/assemblyReportAvailability'
import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, ClipboardCheck, Minus, Plus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { useAppData } from '@/hooks/useAppData'
import { cancelAssemblyTask, confirmAssemblyPlan, correctAssemblyReport, createAssemblyPlan, warnAdmin } from '@/persistence/actions'
import { allocateStock, compositionCapacity, describeShortage, formatNumber, matchDemands, taskDemands } from '@/domain/calculations'
import { previewAssemblyReservation } from '@/domain/expectedOutput'
import { QuickViewLink } from '@/ui/QuickViewLink'
import type { AssemblyReport, AssemblyTask, ImportedComposition, ManualComposition } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

import { AssemblyReportDialog } from '@/ui/AssemblyReportDialog'

type Composition = ImportedComposition | ManualComposition
interface DraftItem { composition: Composition; comment?: string; jointAssembly?: boolean }
const statusLabels = { draft: 'Черновик', pending: 'Ожидает подтверждения', confirmed: 'Подтверждено', partial: 'Выполнено частично', completed: 'Выполнено', transferred: 'Перенесено', cancelled: 'Отменено' }
const kindLabels = { x6: '×6', mega6: 'Мега ×6', x16: '×16', x30: '×30', subscription: 'Подписка', limit: 'Лимита' }
const reportable = ['confirmed', 'partial', 'transferred']
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Ошибка операции'
const isPlanQuantity = (quantity: number) => Number.isSafeInteger(quantity) && quantity > 0
const shortageLabel = (available: number, requested: number) => `Доступно ${formatNumber(available)} из ${formatNumber(requested)} наборов`

export default function AssemblyPage() {
  const data = useAppData()
  const { unlocked } = useAdmin()
  const { hash } = useLocation()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'tasks' | 'plan'>('tasks')
  const activeTab = !unlocked || hash.startsWith('#task-') ? 'tasks' : hash.startsWith('#plan-') ? 'plan' : tab
  const [plan, setPlan] = useState<DraftItem[]>([])
  const [editingPlanId, setEditingPlanId] = useState<string>()
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [approval, setApproval] = useState<{ planId: string; preview: ReturnType<typeof previewAssemblyReservation> }>()
  const [busy, setBusy] = useState(false)
  const [reportTask, setReportTask] = useState<AssemblyTask>()
  const [warningTask, setWarningTask] = useState<AssemblyTask>()
  const [warningText, setWarningText] = useState('')
  const [cancelTask, setCancelTask] = useState<AssemblyTask>()
  const [cancelReason, setCancelReason] = useState('')
  const [correction, setCorrection] = useState<AssemblyReport>()
  const [correctionQuantity, setCorrectionQuantity] = useState(0)
  const [correctionComment, setCorrectionComment] = useState('')

  const today = format(new Date(), 'yyyy-MM-dd')
  const dayClosed = data.productionDays.some(({ date, status }) => date === today && status === 'closed')
  const loading = data.loading
  useEffect(() => {
    if (!loading && hash) document.getElementById(hash.slice(1))?.focus()
  }, [hash, loading, activeTab, unlocked])
  const switchTab = (next: 'tasks' | 'plan') => {
    setTab(next)
    if (hash) void navigate('/assembly', { replace: true })
  }
  const compositions: Composition[] = [...data.importedCompositions, ...data.manualCompositions].filter((item) => item.enabled)
  const planEntries = plan.map((entry) => ({ ...entry, quantity: Number(quantities[entry.composition.id] ?? 1) }))
  const canSavePlan = planEntries.length > 0 && planEntries.every(({ quantity }) => isPlanQuantity(quantity))
  const tasks = data.assemblyTasks.filter(({ status }) => unlocked || !['pending', 'draft', 'cancelled'].includes(status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  async function submit(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try { await action() } catch (error) { toast.error(errorText(error)) } finally { setBusy(false) }
  }

  function savePlan() {
    if (!unlocked || !canSavePlan) return
    void submit(async () => {
      await createAssemblyPlan(planEntries, undefined, false, editingPlanId)
      toast.success('Черновик дневного плана сохранён')
      resetEditor()
    })
  }

  function resetEditor() {
    setPlan([])
    setQuantities({})
    setEditingPlanId(undefined)
  }

  function editPlan(planId: string, pendingTasks: AssemblyTask[]) {
    const entries = pendingTasks.flatMap((task) => {
      const composition = compositions.find(({ id }) => id === task.compositionId)
      if (!composition) return []
      return [{ composition, quantity: task.plannedQuantity, comment: task.comment, jointAssembly: task.jointAssembly }]
    })
    setPlan(entries.map(({ composition, comment, jointAssembly }) => ({ composition, comment, jointAssembly })))
    setQuantities(Object.fromEntries(entries.map(({ composition, quantity }) => [composition.id, String(quantity)])))
    setEditingPlanId(planId)
    if (entries.length !== pendingTasks.length) toast.info('Устаревшие составы исключены. Добавьте актуальные составы в план.')
  }

  function reserve(planId: string, approvalKey?: string, expectedApproval?: string) {
    if (!unlocked) return
    void submit(async () => {
      setApproval(undefined)
      await confirmAssemblyPlan(planId, approvalKey, expectedApproval)
      if (editingPlanId === planId) resetEditor()
      toast.success('Резерв подтверждён')
      switchTab('tasks')
    })
  }

  function onFormSubmit(event: FormEvent, action: () => Promise<void>) {
    event.preventDefault()
    void submit(action)
  }

  return <>
    <PageHeader title="Сборка" description="Расчёт наборов, дневной план и задания участку" />
    {unlocked && <div className="filter-pills mb-5" aria-label="Раздел сборки">
      <Button variant="secondary" aria-pressed={activeTab === 'tasks'} onClick={() => switchTab('tasks')}>Задания</Button>
      <Button variant="secondary" aria-pressed={activeTab === 'plan'} onClick={() => switchTab('plan')}>План</Button>
    </div>}
    {activeTab === 'plan' && unlocked && <>
      <section>
        <div className="section-title"><h2>Доступные составы</h2><span>{compositions.length}</span></div>
        {!compositions.length ? <Empty title="Нет активных составов" text="Создайте или включите состав в одноимённом разделе." /> :
          <div className="card-grid">{compositions.map((composition) => {
            const selected = plan.some((entry) => entry.composition.id === composition.id)
            const otherDemands = planEntries.filter((entry) => entry.composition.id !== composition.id && isPlanQuantity(entry.quantity))
              .flatMap((entry) => matchDemands(entry.composition.items, entry.quantity, entry.composition.kind))
            const physical = compositionCapacity(composition.items, data.inventory.map((lot) => ({ ...lot, reserved: 0 })))
            const capacity = compositionCapacity(composition.items, data.inventory, otherDemands, composition.kind)
            const rawQuantity = quantities[composition.id] ?? '1'
            const quantity = Number(rawQuantity)
            const validQuantity = isPlanQuantity(quantity)
            const short = validQuantity && quantity > capacity.maximum
            const requested = validQuantity && !short ? allocateStock([...otherDemands, ...matchDemands(composition.items, quantity, composition.kind)], data.inventory) : undefined
            return <Card key={composition.id}>
              <p className="eyebrow">{kindLabels[composition.kind]}</p>
              <h3 className="card-title">{composition.name}</h3>
              <div className="my-4 flex flex-wrap items-end justify-between gap-2">
                <div><strong className="text-3xl">{formatNumber(capacity.maximum)}</strong>{' '}<span className="text-sm text-muted">наборов доступно</span>
                  <p className="text-sm text-muted">По физическому остатку {formatNumber(physical.maximum)}</p></div>
                {capacity.limiting && <Badge>Ограничивает {capacity.limiting.item.country} / {capacity.limiting.item.coffeeName}</Badge>}
              </div>
              <ul className="mb-3 grid gap-1 text-sm">{capacity.matches.map(({ item, matched, ambiguous, available }) =>
                <li key={item.id} className={matched && !ambiguous ? 'text-muted' : 'text-danger'}>{item.country} / {item.coffeeName} · {ambiguous ? 'требуется сопоставление' : matched ? `${formatNumber(available)} шт. доступно` : 'лот не сопоставлен'}</li>)}</ul>
              {requested?.moves.length && !requested.shortages.length ? <p className="mb-2 text-sm text-muted">Понадобится подтверждение использования другого назначения.</p> : null}
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label="Количество наборов">
                    <Input aria-label={`Количество ${composition.name}`} aria-invalid={!validQuantity} type="number" min="1" step="1" value={rawQuantity} onChange={(event) => {
                      const value = event.target.value
                      setQuantities((current) => ({ ...current, [composition.id]: value }))
                    }} />
                  </Field>
                </div>
                <Button variant="secondary" disabled={!selected && !validQuantity} onClick={() => setPlan((current) => selected
                  ? current.filter((entry) => entry.composition.id !== composition.id)
                  : [...current, { composition }])}>
                  {selected ? <Minus size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}
                  {selected ? 'Убрать из плана' : 'В план'}
                </Button>
              </div>
              <div role="status" className="mt-2 text-sm text-danger empty:hidden">
                {!validQuantity ? 'Введите целое положительное количество' : short ? shortageLabel(capacity.maximum, quantity) : null}
              </div>
            </Card>
          })}</div>}
      </section>
      {(plan.length > 0 || editingPlanId) && <Card className="my-5">
        <h2 className="card-title">{editingPlanId ? 'Пересчёт дневного плана' : 'Дневной план'}</h2>
        {planEntries.map(({ composition, quantity, comment: text, jointAssembly }) => <div className="my-3 grid gap-2" key={composition.id}>
          <div className="detail-line"><strong>{composition.name} · {isPlanQuantity(quantity) ? `${formatNumber(quantity)} наб.` : 'Укажите количество'}</strong><Button variant="ghost" size="sm" onClick={() => setPlan((current) => current.filter((entry) => entry.composition.id !== composition.id))}>Убрать</Button></div>
          <label className="check-filter min-h-9">
            <input type="checkbox" checked={Boolean(jointAssembly)} onChange={(event) => {
              const checked = event.target.checked
              setPlan((current) => current.map((entry) => entry.composition.id === composition.id ? { ...entry, jointAssembly: checked } : entry))
            }} />
            Совместная сборка
          </label>
          <Field label={`Комментарий к заданию «${composition.name}»`}><Input value={text ?? ''} onChange={(event) => setPlan((current) => current.map((entry) => entry.composition.id === composition.id ? { ...entry, comment: event.target.value } : entry))} /></Field>
        </div>)}
        <div className="flex flex-wrap gap-2"><Button variant="ghost" onClick={resetEditor}>{editingPlanId ? 'Отменить изменения' : 'Очистить'}</Button><Button disabled={busy || !canSavePlan} onClick={savePlan}>{editingPlanId ? 'Сохранить пересчёт' : 'Сформировать план'}</Button></div>
      </Card>}
      {data.assemblyPlans.filter(({ id, status }) => status === 'draft' && id !== editingPlanId).map((item) => {
        const pendingTasks = data.assemblyTasks.filter(({ planId, status }) => planId === item.id && status === 'pending')
        if (!pendingTasks.length) return null
        const demands = taskDemands(pendingTasks)
        const closed = data.productionDays.find(({ date, status }) => date === item.date && status === 'closed')
        const preview = previewAssemblyReservation(pendingTasks, data, closed?.nextWorkingDate ?? item.date, today)
        return <div key={item.id} className="my-4" id={`plan-${item.id}`} tabIndex={-1}><Card>
          <h3 className="card-title">План на {format(parseISO(item.date), 'dd.MM.yyyy')}</h3>
          <ul className="my-3 grid gap-1 text-sm">{pendingTasks.map((task) => {
            const maximum = preview.physical.shortages.length ? compositionCapacity(task.compositionSnapshot, data.inventory,
              demands.filter(({ taskId }) => taskId !== task.id), task.compositionKind).maximum : task.plannedQuantity
            return <li key={task.id}>
              {task.name} · {formatNumber(task.plannedQuantity)} наб.{task.jointAssembly && <p className="text-muted">Совместная сборка</p>}
              {maximum < task.plannedQuantity && <p className="text-danger">{shortageLabel(maximum, task.plannedQuantity)}</p>}
            </li>
          })}</ul>
          {preview.shortages.map((issue, index) => <p key={index} className="mb-2 text-sm text-danger">{describeShortage(issue)}</p>)}
          {preview.expected.length > 0 && <ExpectedCoverage preview={preview} />}
          {!preview.shortages.length && preview.physical.moves.length > 0 && <p className="notice my-3">Для запуска требуется подтвердить перенос остатков другого назначения.</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => editPlan(item.id, pendingTasks)}>Пересчитать план</Button>
            <Button disabled={busy || preview.shortages.length > 0} onClick={() => {
              if (preview.physical.moves.length || preview.expected.length) setApproval({ planId: item.id, preview })
              else reserve(item.id)
            }}>{preview.expected.length ? 'Согласовать резерв под выпуск' : 'Подтвердить резерв'}</Button>
          </div>
        </Card></div>
      })}
    </>}
    {activeTab === 'tasks' && <section>
      <div className="section-title"><h2>Задания участка</h2><span>{tasks.length}</span></div>
      {!tasks.length ? <Empty title="Заданий пока нет" text="Подтверждённый план сборки появится здесь." /> : <div className="grid gap-4">{tasks.map((task) => {
        const remaining = task.plannedQuantity - task.completedQuantity
        const expected = data.expectedReservations.filter(({ assemblyTaskId }) => assemblyTaskId === task.id)
        const reports = data.assemblyReports.filter((item) => item.taskId === task.id)
        const canReport = canReportAssembly(task, data)
        const jointSubmitted = task.jointAssembly && reports.some(({ productionDate }) => productionDate === today)
        return <Card key={task.id}>
          <div id={`task-${task.id}`} tabIndex={-1} className="task-head">
            <div><div className="mb-2 flex flex-wrap gap-2"><Badge tone={task.status === 'completed' ? 'success' : task.status === 'cancelled' ? 'neutral' : 'accent'}>{statusLabels[task.status]}</Badge>{task.jointAssembly && <Badge>Совместная сборка</Badge>}{expected.length > 0 && <Badge tone="warning">Под ожидаемый выпуск</Badge>}</div><h3 className="card-title">{task.name}</h3><p className="text-sm text-muted">Смена <time dateTime={task.productionDate}>{format(parseISO(task.productionDate), 'dd.MM.yyyy')}</time></p></div>
            <div className="text-right"><strong className="text-2xl">{task.completedQuantity} / {task.plannedQuantity}</strong><span className="block text-sm text-muted">{task.status === 'cancelled' ? 'Отменено' : 'Осталось'} {formatNumber(remaining)} наб.</span></div>
          </div>
          <div className="my-4 grid gap-2">
            {task.compositionSnapshot.map((item) => <div className="composition-item" key={item.id}><span>{item.country} / {item.coffeeName} <small className="text-muted">· {item.quantityPerSet} шт. в наборе</small></span><strong>{formatNumber(item.quantityPerSet * task.plannedQuantity)} шт.</strong></div>)}
            <div className="composition-item"><span>Всего пакетов по плану</span><strong>{formatNumber(task.compositionSnapshot.reduce((sum, item) => sum + item.quantityPerSet * task.plannedQuantity, 0))} шт.</strong></div>
          </div>
          {expected.length > 0 && <p className="mb-3 text-sm text-muted">Ожидается поступление {formatNumber(expected.reduce((sum, row) => sum + row.quantity, 0))} шт.</p>}
          {task.comment && <p className="my-3 text-sm">{task.comment}</p>}
          {reports.length > 0 && <details className="mb-3"><summary className="cursor-pointer text-sm">Отчётов {reports.length}</summary>
            <div className="mt-2 grid gap-2">{reports.map((report) => {
              const participants = assemblyParticipantNames(report, data.employees).join(', ')
              return <div key={report.id} className="detail-line text-sm"><div><strong>{participants || 'Нулевой факт'} · {report.quantity} наб.</strong>
                <p className="text-muted">{format(parseISO(report.createdAt), 'dd.MM.yyyy HH:mm')}{report.recordedBy === 'administrator' && ' · Внёс администратор'}</p>
                {report.comment && <p className="text-muted">{report.comment}</p>}{report.correctionComment && <p className="text-muted">Исправлено с {report.previousQuantity}. {report.correctionComment}</p>}</div>
                {unlocked && participants && <Button variant="ghost" size="sm" onClick={() => { setCorrection(report); setCorrectionQuantity(report.quantity); setCorrectionComment('') }}>Исправить отчёт</Button>}
              </div>
            })}</div>
          </details>}
          <div className="mt-4 flex flex-wrap gap-2">
            {reportable.includes(task.status) && <>
              <Button disabled={!canReport} onClick={() => setReportTask(task)}><ClipboardCheck size={17} />Отчитаться</Button>
              <Button variant="secondary" onClick={() => { setWarningText(''); setWarningTask(task) }}><AlertTriangle size={17} />Предупредить администратора</Button>
            </>}
            {unlocked && !['completed', 'cancelled'].includes(task.status) && <Button variant="ghost" onClick={() => { setCancelReason(''); setCancelTask(task) }}>Отменить остаток</Button>}
          </div>
          {reportable.includes(task.status) && !canReport && <p className="mt-2 text-sm text-muted">{dayClosed ? 'Производственный день закрыт.' : task.productionDate > today ? 'Отчёт будет доступен в назначенную смену.' : jointSubmitted ? 'Совместный отчёт за эту смену уже отправлен.' : task.jointAssembly ? 'Для совместного отчёта нужны два активных сотрудника.' : 'Для отчёта требуется активный сотрудник.'}</p>}
        </Card>
      })}</div>}
    </section>}
    {approval && unlocked && <Modal title={approval.preview.expected.length ? 'Согласовать резерв под ожидаемый выпуск' : 'Согласовать переназначение'} onClose={() => setApproval(undefined)}>
      {approval.preview.expected.length > 0 && <ExpectedCoverage preview={approval.preview} />}
      {approval.preview.physical.moves.length > 0 && <>
        <h3 className="mb-2 font-semibold">Переназначение фактического стока</h3>
        <ul className="mb-4 grid gap-2">{approval.preview.physical.moves.map(({ demand, lot, quantity }, index) => <li className="detail-line" key={index}><span>{lot.country} / {lot.coffeeName}<br /><small>{lot.purpose} → {demand.purpose}</small></span><strong>{formatNumber(quantity)} шт.</strong></li>)}</ul>
      </>}
      <Button disabled={busy} onClick={() => reserve(approval.planId, approval.preview.physical.approvalKey, approval.preview.approvalKey)}>
        {approval.preview.expected.length
          ? (approval.preview.physical.moves.length ? 'Подтвердить резерв под выпуск и переназначение' : 'Подтвердить резерв под ожидаемый выпуск')
          : 'Подтвердить переназначение и резерв'}
      </Button>
    </Modal>}
    {reportTask && <AssemblyReportDialog task={tasks.find(({ id }) => id === reportTask.id) ?? reportTask} onClose={() => setReportTask(undefined)} />}
    {warningTask && <Modal title="Предупредить администратора" onClose={() => setWarningTask(undefined)}>
      <form className="grid gap-4" onSubmit={(event) => onFormSubmit(event, async () => {
        await warnAdmin(warningTask.id, warningText)
        toast.success('Предупреждение передано')
        setWarningTask(undefined)
      })}><Field label="Что случилось?"><Textarea autoFocus required value={warningText} onChange={(event) => setWarningText(event.target.value)} placeholder="Опишите проблему или брак" /></Field><Button disabled={busy}>Отправить предупреждение</Button></form>
    </Modal>}
    {cancelTask && unlocked && <Modal title="Отмена остатка задания" onClose={() => setCancelTask(undefined)}>
      <form className="grid gap-4" onSubmit={(event) => onFormSubmit(event, async () => {
        await cancelAssemblyTask(cancelTask.id, cancelReason)
        toast.success('Остаток отменён, резерв освобождён')
        setCancelTask(undefined)
      })}><div className="notice">Отчёты останутся в истории. Неиспользованный резерв будет освобождён.</div><Field label="Причина"><Textarea required value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} /></Field><Button variant="danger" disabled={busy}>Подтвердить отмену</Button></form>
    </Modal>}
    {correction && unlocked && <Modal title="Исправление отчёта администратором" onClose={() => setCorrection(undefined)}>
      <form className="grid gap-4" onSubmit={(event) => onFormSubmit(event, async () => {
        await correctAssemblyReport(correction.id, correctionQuantity, correctionComment)
        toast.success('Отчёт и детализация списаний исправлены')
        setCorrection(undefined)
      })}><div className="notice">Прежнее значение {correction.quantity}. Изменение стока и резерва сохранится в истории.</div><Field label="Новое количество наборов"><Input required type="number" min="0" step="1" value={correctionQuantity} onChange={(event) => setCorrectionQuantity(Number(event.target.value))} /></Field><Field label="Обязательный комментарий"><Textarea required value={correctionComment} onChange={(event) => setCorrectionComment(event.target.value)} /></Field><Button disabled={busy}>Сохранить исправление</Button></form>
    </Modal>}
  </>
}

function ExpectedCoverage({ preview }: { preview: ReturnType<typeof previewAssemblyReservation> }) {
  return <div className="notice my-3">
    <h4 className="font-semibold">Покрытие сегодняшним выпуском</h4>
    <ul className="grid gap-2">
      {preview.expected.map(({ demand, lot, quantity }) => <li className="detail-line" key={JSON.stringify([demand.taskId, demand.item.id, lot.id])}>
        <div>
          <p>{demand.name} · не хватает {formatNumber(quantity)} шт.</p>
          <QuickViewLink className="underline" to={`/production?task=${encodeURIComponent(lot.productionTaskId)}`}>{lot.country} / {lot.coffeeName} · {lot.purpose}</QuickViewLink>
        </div>
      </li>)}
    </ul>
  </div>
}
