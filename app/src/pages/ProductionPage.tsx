import { useState, type FormEvent } from 'react'
import { Check, PackageCheck } from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { useAppData } from '@/hooks/useAppData'
import { approveSchedule, markBU, produce, writeOffProduction } from '@/persistence/repository'
import { formatNumber, remainingCoffee } from '@/domain/calculations'
import type { ProductionTask } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

export default function ProductionPage() {
  const data = useAppData(); const { unlocked, requestUnlock } = useAdmin()
  const [selected, setSelected] = useState<ProductionTask | null>(null)
  const [writeOff, setWriteOff] = useState<ProductionTask | null>(null)
  const [filter, setFilter] = useState('active')
  const [quantity, setQuantity] = useState(1); const [employeeId, setEmployeeId] = useState(''); const [comment, setComment] = useState('')
  const [weight, setWeight] = useState(0); const [reason, setReason] = useState('')
  const adminAction = (action: () => void) => { if (!unlocked) requestUnlock(); else action() }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected) return
    try {
      const updated = { ...selected, producedQuantity: selected.producedQuantity + quantity }
      await produce(selected.id, quantity, employeeId, comment)
      setSelected(null); setQuantity(1); setComment('')
      const formatDef = data.settings.formats.find((item) => item.id === selected.formatId)
      const remainder = formatDef ? remainingCoffee(updated, formatDef) : 0
      if (remainder > 1e-9) {
        setWriteOff(updated); setWeight(Number(remainder.toFixed(6))); setReason('')
        toast.success(`${quantity} шт. добавлено на сток. Можно списать остаток`)
      } else toast.success(`${quantity} шт. добавлено на сток`)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка сохранения') }
  }
  const tasks = data.productionTasks.filter((task) => filter === 'all' || (filter === 'active' ? task.status === 'open' : task.status === filter)).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))
  return <>
    <PageHeader title="Производство" description="Задачи изготовления, частичные приходы и остатки кофе" action={<select className="field-control w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="active">Открытые</option><option value="completed">Завершённые</option><option value="all">Все задачи</option></select>} />
    {!tasks.length ? <Empty title="Задач нет" text="Создайте лот с назначениями — задачи появятся здесь автоматически." /> : <div className="grid gap-4">{tasks.map((task) => { const lot = data.lots.find((item) => item.id === task.lotId); const formatDef = data.settings.formats.find((item) => item.id === task.formatId); const allocations = data.allocations.filter((item) => item.lotId === task.lotId && item.formatId === task.formatId); const entries = data.productionEntries.filter((item) => item.taskId === task.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); const responsible = data.employees.find((item) => item.id === task.responsibleId); return <Card key={task.id}><div className="task-head"><div><div className="mb-2 flex flex-wrap gap-2"><Badge tone={task.status === 'completed' ? 'success' : 'accent'}>{task.status === 'completed' ? 'Завершено' : 'Открыто'}</Badge>{task.inBU && <Badge tone="warning">Находится в Б/у</Badge>}{!task.approved && <Badge tone="warning">Нужно подтверждение</Badge>}</div><h2 className="card-title">{lot?.country} / {lot?.name}</h2><p className="text-sm text-muted">{formatDef?.name} · {allocations.map((item) => item.purpose).join(', ')}</p></div><div className="text-right"><strong className="text-2xl">{formatNumber(task.producedQuantity)}</strong><span className="block text-sm text-muted">из ≈ {formatNumber(task.plannedQuantity)} шт.</span></div></div><div className="progress-track"><div className="progress-value" style={{ width: `${Math.min(100, task.producedQuantity / Math.max(1, task.plannedQuantity) * 100)}%` }} /></div><dl className="metric-row four"><div><dt>Исходный вес</dt><dd>{task.sourceWeightKg.toFixed(2)} кг</dd></div><div><dt>Остаток задачи</dt><dd>{formatNumber(Math.max(0, task.plannedQuantity - task.producedQuantity))} шт.</dd></div><div><dt>Кофе осталось</dt><dd>≈ {formatDef ? remainingCoffee(task, formatDef).toFixed(3) : 0} кг</dd></div><div><dt>Дата</dt><dd>{format(new Date(task.plannedDate), 'dd.MM.yyyy')}</dd></div></dl><p className="mt-3 text-sm text-muted">Последнее изготовление: {entries[0] ? format(new Date(entries[0].createdAt), 'dd.MM.yyyy HH:mm') : 'ещё не было'} · {responsible ? `${responsible.lastName} ${responsible.firstName}` : 'Ответственный не назначен'}</p>{task.comment && <p className="mt-2 text-sm">{task.comment}</p>}<div className="mt-4 flex flex-wrap gap-2">{!task.approved && <Button variant="secondary" onClick={() => adminAction(() => approveSchedule(task.id).then(() => toast.success('Дата подтверждена')).catch((e) => toast.error(e.message)))}><Check size={17} />Подтвердить дату</Button>}{task.scheduleDecision === 'bu' && !task.inBU && <Button variant="secondary" onClick={() => adminAction(() => markBU(task.id).then(() => toast.success('Отмечено: находится в Б/у')))}>Запаковать в Б/у</Button>}{task.status === 'open' && <Button onClick={() => adminAction(() => { setSelected(task); setEmployeeId(task.responsibleId ?? data.employees.find((item) => item.active)?.id ?? '') })}><PackageCheck size={17} />Изготовлено</Button>}{task.status === 'open' && <Button variant="ghost" onClick={() => adminAction(() => { setWriteOff(task); setWeight(formatDef ? remainingCoffee(task, formatDef) : 0) })}>Списать остаток</Button>}</div></Card>})}</div>}
    {selected && <Modal title={`Изготовлено: ${data.settings.formats.find((item) => item.id === selected.formatId)?.name}`} onClose={() => setSelected(null)}><form className="grid gap-4" onSubmit={submit}><Field label="Фактическое количество, шт."><Input autoFocus type="number" min="1" step="1" required value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} /></Field><Field label="Ответственный"><select required className="field-control" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}><option value="">Выберите сотрудника</option>{data.employees.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.lastName} {item.firstName}</option>)}</select></Field><Field label="Комментарий"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field><Button>Отправить на сток</Button></form></Modal>}
    {writeOff && <Modal title="Списать остаток кофе?" onClose={() => setWriteOff(null)}><form className="grid gap-4" onSubmit={async (e) => { e.preventDefault(); try { await writeOffProduction(writeOff.id, weight, reason); toast.success('Списание сохранено'); setWriteOff(null); setReason('') } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка') } }}><p className="text-sm text-muted">После изготовления осталось кофе. Если списать весь остаток, задача перейдёт в завершённые.</p><Field label="Вес, кг"><Input type="number" min="0.000001" step="any" required value={weight} onChange={(e) => setWeight(Number(e.target.value))} /></Field><Field label="Причина"><Textarea required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например: технологический остаток" /></Field><div className="modal-actions"><Button type="button" variant="ghost" onClick={() => setWriteOff(null)}>Не списывать</Button><Button variant="danger">Подтвердить списание</Button></div></form></Modal>}
  </>
}
