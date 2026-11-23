import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, CheckCircle2, ClipboardCheck, Plus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { useAppData } from '@/hooks/useAppData'
import { cancelAssemblyTask, confirmAssemblyPlan, correctAssemblyReport, createAssemblyPlan, reportAssembly, warnAdmin } from '@/persistence/repository'
import { allocateStock, compositionCapacity, describeShortage, formatNumber, matchDemands, taskDemands } from '@/domain/calculations'
import type { AssemblyReport, AssemblyTask, ImportedComposition, ManualComposition } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

type Composition = ImportedComposition | ManualComposition
interface DraftItem { composition: Composition; quantity: number; comment?: string }
const statusLabels = { draft: 'Черновик', pending: 'Ожидает подтверждения', confirmed: 'Подтверждено', partial: 'Выполнено частично', completed: 'Выполнено', transferred: 'Перенесено', cancelled: 'Отменено' }
const kindLabels = { x6: '×6', mega6: 'Мега ×6', x16: '×16', x30: '×30', subscription: 'Подписка', limit: 'Лимита' }
const reportable = ['confirmed', 'partial', 'transferred']
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Ошибка операции'

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
  const [approval, setApproval] = useState<{ planId: string; preview: ReturnType<typeof allocateStock> }>()
  const [busy, setBusy] = useState(false)
  const [reportTask, setReportTask] = useState<AssemblyTask>()
  const [employeeId, setEmployeeId] = useState('')
  const [reportQuantity, setReportQuantity] = useState(1)
  const [comment, setComment] = useState('')
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
  const activeEmployees = data.employees.filter(({ active }) => active)
  const tasks = data.assemblyTasks.filter(({ status }) => unlocked || !['pending', 'draft', 'cancelled'].includes(status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  async function submit(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try { await action() } catch (error) { toast.error(errorText(error)) } finally { setBusy(false) }
  }

  function savePlan() {
    if (!unlocked) return
    void submit(async () => {
      await createAssemblyPlan(plan, undefined, false, editingPlanId)
      toast.success('Дневной план подготовлен. Подтвердите резерв.')
      resetEditor()
    })
  }

  function resetEditor() {
    setPlan([])
    setEditingPlanId(undefined)
  }

  function editPlan(planId: string, pendingTasks: AssemblyTask[]) {
    const entries = pendingTasks.flatMap((task) => {
      const composition = compositions.find(({ id }) => id === task.compositionId)
      if (!composition) return []
      return [{ composition, quantity: task.plannedQuantity, comment: task.comment }]
    })
    setPlan(entries)
    setQuantities(Object.fromEntries(entries.map(({ composition, quantity }) => [composition.id, String(quantity)])))
    setEditingPlanId(planId)
    if (entries.length !== pendingTasks.length) toast.info('Устаревшие составы исключены. Добавьте актуальные составы в план.')
  }

  function reserve(planId: string, approvalKey?: string) {
    if (!unlocked) return
    void submit(async () => {
      setApproval(undefined)
      await confirmAssemblyPlan(planId, approvalKey)
      if (editingPlanId === planId) resetEditor()
      toast.success('Резерв подтверждён')
      switchTab('tasks')
    })
  }

  function openReport(task: AssemblyTask) {
    setReportTask(task)
    setReportQuantity(task.plannedQuantity - task.completedQuantity)
    setEmployeeId('')
    setComment('')
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
            const selection = plan.find((entry) => entry.composition.id === composition.id)
            const otherDemands = plan.filter((entry) => entry !== selection)
              .flatMap((entry) => matchDemands(entry.composition.items, entry.quantity, entry.composition.kind))
            const physical = compositionCapacity(composition.items, data.inventory.map((lot) => ({ ...lot, reserved: 0 })))
            const capacity = compositionCapacity(composition.items, data.inventory, otherDemands)
            const rawQuantity = quantities[composition.id] ?? String(selection?.quantity ?? 1)
            const quantity = Number(rawQuantity)
            const validQuantity = Number.isSafeInteger(quantity) && quantity > 0
            const requested = validQuantity ? allocateStock([...otherDemands, ...matchDemands(composition.items, quantity, composition.kind)], data.inventory) : undefined
            return <Card key={composition.id}>
              <p className="eyebrow">{kindLabels[composition.kind]}</p>
              <h3 className="card-title">{composition.name}</h3>
              <div className="my-4 flex flex-wrap items-end justify-between gap-2">
                <div><strong className="text-3xl">{formatNumber(capacity.maximum)}</strong><span className="ml-2 text-sm text-muted">наборов доступно</span>
                  <p className="text-sm text-muted">По физическому остатку {formatNumber(physical.maximum)}</p></div>
                {capacity.limiting && <Badge>Ограничивает {capacity.limiting.item.country} / {capacity.limiting.item.coffeeName}</Badge>}
              </div>
              <ul className="mb-3 grid gap-1 text-sm">{capacity.matches.map(({ item, matched, ambiguous, available }) =>
                <li key={item.id} className={matched && !ambiguous ? 'text-muted' : 'text-danger'}>{item.country} / {item.coffeeName} · {ambiguous ? 'требуется сопоставление' : matched ? `${formatNumber(available)} шт. доступно` : 'лот не сопоставлен'}</li>)}</ul>
              {requested?.shortages.filter(({ reason }) => reason === 'shortage').map((issue, index) => <p className="mb-2 text-sm text-danger" key={index}>{describeShortage(issue)}</p>)}
              {requested?.moves.length && !requested.shortages.length ? <p className="mb-2 text-sm text-muted">Понадобится подтверждение использования другого назначения.</p> : null}
              <div className="flex gap-2">
                <Input aria-label={`Количество ${composition.name}`} type="number" min="1" max={Math.max(1, capacity.maximum)} value={rawQuantity} onChange={(event) => setQuantities({ ...quantities, [composition.id]: event.target.value })} />
                <Button variant="secondary" disabled={!capacity.valid || !validQuantity || quantity > capacity.maximum} onClick={() => setPlan((current) => [...current.filter((item) => item.composition.id !== composition.id), { composition, quantity, comment: selection?.comment }])}><Plus size={17} />{selection ? 'Обновить' : 'В план'}</Button>
              </div>
            </Card>
          })}</div>}
      </section>
      {(plan.length > 0 || editingPlanId) && <Card className="my-5">
        <h2 className="card-title">{editingPlanId ? 'Пересчёт дневного плана' : 'Дневной план'}</h2>
        {plan.map(({ composition, quantity, comment: text }) => <div className="my-3 grid gap-2" key={composition.id}>
          <div className="detail-line"><strong>{composition.name} · {formatNumber(quantity)} наб.</strong><Button variant="ghost" size="sm" onClick={() => setPlan((current) => current.filter((entry) => entry.composition.id !== composition.id))}>Убрать</Button></div>
          <Field label={`Комментарий к заданию «${composition.name}»`}><Input value={text ?? ''} onChange={(event) => setPlan((current) => current.map((entry) => entry.composition.id === composition.id ? { ...entry, comment: event.target.value } : entry))} /></Field>
        </div>)}
        <div className="flex flex-wrap gap-2"><Button variant="ghost" onClick={resetEditor}>{editingPlanId ? 'Отменить изменения' : 'Очистить'}</Button><Button disabled={busy || !plan.length} onClick={savePlan}>{editingPlanId ? 'Сохранить пересчёт' : 'Сформировать план'}</Button></div>
      </Card>}
      {data.assemblyPlans.filter(({ status }) => status === 'draft').map((item) => {
        const pendingTasks = data.assemblyTasks.filter(({ planId, status }) => planId === item.id && status === 'pending')
        if (!pendingTasks.length) return null
        const preview = allocateStock(taskDemands(pendingTasks), data.inventory)
        return <div key={item.id} className="my-4" id={`plan-${item.id}`} tabIndex={-1}><Card>
          <h3 className="card-title">План на {format(parseISO(item.date), 'dd.MM.yyyy')}</h3>
          <ul className="my-3 grid gap-1 text-sm">{pendingTasks.map((task) => <li key={task.id}>{task.name} · {formatNumber(task.plannedQuantity)} наб.</li>)}</ul>
          {preview.shortages.map((issue, index) => <p key={index} className="mb-2 text-sm text-danger">{describeShortage(issue)}</p>)}
          {!preview.shortages.length && preview.moves.length > 0 && <p className="notice my-3">Для запуска требуется подтвердить перенос остатков другого назначения.</p>}
          <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => editPlan(item.id, pendingTasks)}>Пересчитать план</Button><Button disabled={busy || preview.shortages.length > 0} onClick={() => preview.moves.length ? setApproval({ planId: item.id, preview }) : reserve(item.id)}>Подтвердить резерв</Button></div>
        </Card></div>
      })}
    </>}
    {activeTab === 'tasks' && <section>
      <div className="section-title"><h2>Задания участка</h2><span>{tasks.length}</span></div>
      {!tasks.length ? <Empty title="Заданий пока нет" text="Подтверждённый план сборки появится здесь." /> : <div className="grid gap-4">{tasks.map((task) => {
        const remaining = task.plannedQuantity - task.completedQuantity
        const reports = data.assemblyReports.filter((item) => item.taskId === task.id)
        return <Card key={task.id}>
          <div id={`task-${task.id}`} tabIndex={-1} className="task-head">
            <div><div className="mb-2 flex flex-wrap gap-2"><Badge tone={task.status === 'completed' ? 'success' : task.status === 'cancelled' ? 'neutral' : 'accent'}>{statusLabels[task.status]}</Badge></div><h3 className="card-title">{task.name}</h3><p className="text-sm text-muted">Смена <time dateTime={task.productionDate}>{format(parseISO(task.productionDate), 'dd.MM.yyyy')}</time></p></div>
            <div className="text-right"><strong className="text-2xl">{task.completedQuantity} / {task.plannedQuantity}</strong><span className="block text-sm text-muted">{task.status === 'cancelled' ? 'Отменено' : 'Осталось'} {formatNumber(remaining)} наб.</span></div>
          </div>
          <div className="my-4 grid gap-2">
            {task.compositionSnapshot.map((item) => <div className="composition-item" key={item.id}><span>{item.country} / {item.coffeeName} <small className="text-muted">· {item.quantityPerSet} шт. в наборе</small></span><strong>{formatNumber(item.quantityPerSet * task.plannedQuantity)} шт.</strong></div>)}
            <div className="composition-item"><span>Всего пакетов по плану</span><strong>{formatNumber(task.compositionSnapshot.reduce((sum, item) => sum + item.quantityPerSet * task.plannedQuantity, 0))} шт.</strong></div>
          </div>
          {task.comment && <p className="my-3 text-sm">{task.comment}</p>}
          {reports.length > 0 && <details className="mb-3"><summary className="cursor-pointer text-sm">Отчётов {reports.length}</summary>
            <div className="mt-2 grid gap-2">{reports.map((report) => {
              const employee = data.employees.find(({ id }) => id === report.employeeId)
              return <div key={report.id} className="detail-line text-sm"><div><strong>{employee ? `${employee.lastName} ${employee.firstName}` : 'Сотрудник'} · {report.quantity} наб.</strong>
                <p className="text-muted">{format(parseISO(report.createdAt), 'dd.MM.yyyy HH:mm')}</p>
                {report.comment && <p className="text-muted">{report.comment}</p>}{report.correctionComment && <p className="text-muted">Исправлено с {report.previousQuantity}. {report.correctionComment}</p>}</div>
                {unlocked && <Button variant="ghost" size="sm" onClick={() => { setCorrection(report); setCorrectionQuantity(report.quantity); setCorrectionComment('') }}>Исправить отчёт</Button>}
              </div>
            })}</div>
          </details>}
          <div className="mt-4 flex flex-wrap gap-2">
            {reportable.includes(task.status) && <>
              <Button disabled={dayClosed || task.productionDate > today || !activeEmployees.length} onClick={() => openReport(task)}><ClipboardCheck size={17} />Отчитаться</Button>
              <Button variant="secondary" onClick={() => { setWarningText(''); setWarningTask(task) }}><AlertTriangle size={17} />Предупредить администратора</Button>
            </>}
            {unlocked && !['completed', 'cancelled'].includes(task.status) && <Button variant="ghost" onClick={() => { setCancelReason(''); setCancelTask(task) }}>Отменить остаток</Button>}
          </div>
          {reportable.includes(task.status) && (dayClosed || task.productionDate > today || !activeEmployees.length) && <p className="mt-2 text-sm text-muted">{dayClosed ? 'Производственный день закрыт.' : task.productionDate > today ? 'Отчёт будет доступен в назначенную смену.' : 'Для отчёта требуется активный сотрудник.'}</p>}
        </Card>
      })}</div>}
    </section>}
    {approval && unlocked && <Modal title="Согласовать переназначение" onClose={() => setApproval(undefined)}>
      <ul className="mb-4 grid gap-2">{approval.preview.moves.map(({ demand, lot, quantity }, index) => <li className="detail-line" key={index}><span>{lot.country} / {lot.coffeeName}<br /><small>{lot.purpose} → {demand.purpose}</small></span><strong>{formatNumber(quantity)} шт.</strong></li>)}</ul>
      <Button disabled={busy} onClick={() => reserve(approval.planId, approval.preview.approvalKey)}>Подтвердить переназначение и резерв</Button>
    </Modal>}
    {reportTask && <Modal title={`Отчёт: ${reportTask.name}`} onClose={() => setReportTask(undefined)}>
      <form className="grid gap-4" onSubmit={(event) => onFormSubmit(event, async () => {
        await reportAssembly(reportTask.id, employeeId, reportQuantity, comment)
        toast.success('Отчёт принят, сток списан по FIFO')
        setReportTask(undefined)
      })}>
        <div className="notice">Осталось {reportTask.plannedQuantity - reportTask.completedQuantity} наборов. Списание произойдёт при отправке отчёта.</div>
        <Field label="Сборщик"><select className="field-control" required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">Выберите фамилию</option>{activeEmployees.map((item) => <option value={item.id} key={item.id}>{item.lastName} {item.firstName}</option>)}</select></Field>
        <Field label="Фактически собрано наборов"><Input required type="number" min="1" max={reportTask.plannedQuantity - reportTask.completedQuantity} value={reportQuantity} onChange={(event) => setReportQuantity(Number(event.target.value))} /></Field>
        <Field label="Комментарий или брак"><Textarea value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
        <Button disabled={busy}><CheckCircle2 size={17} />Отправить отчёт</Button>
      </form>
    </Modal>}
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
