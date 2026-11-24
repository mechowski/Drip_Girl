import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { Link, useSearchParams } from 'react-router'
import { useAppData } from '@/hooks/useAppData'
import { createLot, deleteLot, updateLot, updateLotDegassing } from '@/persistence/repository'
import { distributeAllocationWeights, formatNumber, lotHasProductionActivity, matchesTaskAllocation, plannedOutput, purposesForFormat, validateAllocations } from '@/domain/calculations'
import type { FormatId } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

interface AllocationDraft {
  formatId: FormatId
  purpose: string
  weightKg: string
  degassingDays: string
  comment: string
  manualWeight?: string
}

const blankAllocation = (weightKg = '5'): AllocationDraft => ({ formatId: 'drip', purpose: '×16', weightKg, degassingDays: '', comment: '' })
const blankForm = () => ({ country: '', name: '', roastDate: format(new Date(), 'yyyy-MM-dd'), weightKg: '5', degassingDays: 3, responsibleId: '', comment: '' })
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

function rebalance(weight: string, items: AllocationDraft[]) {
  const amounts = distributeAllocationWeights(weight, items.map((item) => item.manualWeight))
  return items.map((item, index) => ({ ...item, weightKg: amounts[index], manualWeight: items.length > 1 ? item.manualWeight : undefined }))
}

export default function LotsPage() {
  const data = useAppData()
  const { unlocked } = useAdmin()
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const fromDashboard = params.has('new')
  const closeForm = () => {
    setOpen(false)
    if (editing) {
      setEditing(false)
      setForm(blankForm())
      setAllocations([blankAllocation()])
    }
    if (fromDashboard) setParams({}, { replace: true })
  }
  const selected = params.get('lot')
  const setSelected = (id: string | null) => setParams((current) => {
    const next = new URLSearchParams(current)
    if (id) next.set('lot', id)
    else next.delete('lot')
    return next
  }, { replace: true })
  const [busy, setBusy] = useState(false)
  const [purpose, setPurpose] = useState('Все')
  const [sort, setSort] = useState('newest')
  const [form, setForm] = useState(blankForm)
  const [allocations, setAllocations] = useState([blankAllocation()])
  const [scheduleForm, setScheduleForm] = useState<{ days: number; byAllocation: Record<string, string> } | null>(null)
  const selectedLot = data.lots.find((lot) => lot.id === selected)
  const selectedAllocations = data.allocations.filter((item) => item.lotId === selected).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

  const selectedTasks = data.productionTasks.filter((task) => task.lotId === selected)
  const hasActivity = lotHasProductionActivity(selectedTasks,
    data.productionEntries.some((entry) => entry.lotId === selected),
    data.inventory.some((item) => item.sourceLotId === selected))
  const linkedComposition = selectedLot && [...data.manualCompositions, ...data.importedCompositions]
    .find(({ items }) => items.some((item) => item.inventoryLotId === selectedLot.id))
  const metadataOnly = editing && hasActivity

  const openForm = () => setOpen(true)
  const openEdit = () => {
    if (!selectedLot) return
    const { country, name, roastDate, weightKg, degassingDays, responsibleId, comment } = selectedLot
    setForm({ country, name, roastDate, weightKg: String(weightKg), degassingDays, responsibleId: responsibleId ?? '', comment: comment ?? '' })
    setAllocations(selectedAllocations.map((item) => ({
      formatId: item.formatId, purpose: item.purpose, weightKg: String(item.weightKg),
      degassingDays: String(item.degassingDays ?? ''), comment: item.comment ?? '',
    })))
    setEditing(true)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!unlocked || busy) return
    setBusy(true)
    try {
      const input = {
        ...form,
        weightKg: Number(form.weightKg),
        responsibleId: form.responsibleId || undefined,
        allocations: allocations.map(({ formatId, purpose, weightKg, degassingDays, comment }) => ({
          formatId, purpose, weightKg: Number(weightKg), degassingDays: degassingDays ? Number(degassingDays) : undefined, comment,
        })),
      }
      if (editing) {
        if (!selectedLot) throw new Error('Лот не найден')
        await updateLot(selectedLot.id, metadataOnly ? { country: form.country, name: form.name, comment: form.comment } : input)
        toast.success('Изменения лота сохранены')
      } else {
        await createLot(input)
        toast.success('Лот и задачи изготовления созданы')
        setForm({ ...form, country: '', name: '', comment: '' })
        setAllocations([blankAllocation(form.weightKg)])
      }
      closeForm()
    } catch (error) {
      toast.error(errorMessage(error, 'Не удалось сохранить лот'))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!unlocked || !selectedLot || busy) return
    setBusy(true)
    try {
      await deleteLot(selectedLot.id)
      setDeleteOpen(false)
      setSelected(null)
      toast.success('Лот удалён')
    } catch (error) {
      toast.error(errorMessage(error, 'Не удалось удалить лот'))
    } finally {
      setBusy(false)
    }
  }
  const allocatedWeight = allocations.reduce((sum, item) => sum + (Number(item.weightKg) || 0), 0)
  const weightDifference = (Number(form.weightKg) || 0) - allocatedWeight
  const weightError = validateAllocations(Number(form.weightKg), allocations.map((item) => ({ weightKg: Number(item.weightKg) })))
  const updateLotWeight = (weightKg: string) => {
    setForm({ ...form, weightKg })
    setAllocations((current) => rebalance(weightKg, current))
  }
  const updateAllocationWeight = (index: number, weight: string) => {
    if (allocations.length === 1) {
      updateLotWeight(weight)
      return
    }
    setAllocations((current) => {
      const updated = current.map((item, i) => i === index ? { ...item, manualWeight: weight } : item)
      if (updated.every((item) => item.manualWeight !== undefined)) {
        const balanceIndex = index === updated.length - 1 ? index - 1 : updated.length - 1
        updated[balanceIndex] = { ...updated[balanceIndex], manualWeight: undefined }
      }
      return rebalance(form.weightKg, updated)
    })
  }
  const visibleLots = data.lots
    .filter((lot) => purpose === 'Все' || data.allocations.some((item) => item.lotId === lot.id && item.purpose === purpose))
    .sort((a, b) => sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : sort === 'weight' ? b.weightKg - a.weightKg : b.createdAt.localeCompare(a.createdAt))
  const totalWeight = data.lots.reduce((sum, lot) => sum + lot.weightKg, 0)

  return <>
    <PageHeader title="Лоты кофе" description={`${data.lots.length} лотов · всего ${formatNumber(totalWeight)} кг после обжарки`} action={unlocked && <Button onClick={openForm}><Plus size={18} />Новый лот</Button>} />
    <div className="filter-pills" aria-label="Фильтры лотов">
      {['Все', ...data.settings.purposes].map((item) => <button type="button" key={item} className={purpose === item ? 'active' : ''} aria-pressed={purpose === item} onClick={() => setPurpose(item)}>{item}</button>)}
      <select className="field-control" aria-label="Сортировка лотов" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option><option value="weight">По убыванию веса</option></select>
    </div>
    {data.lots.length === 0 ? <Empty title="Пока нет лотов" text={unlocked ? "Зарегистрируйте первый обжаренный лот — система рассчитает выход и производственные даты." : "Зарегистрированные лоты появятся здесь."} action={unlocked && <Button onClick={openForm}>Создать лот</Button>} /> : visibleLots.length === 0 ? <Empty title="Лотов с таким назначением нет" text="Выберите другой фильтр, чтобы увидеть доступные лоты." action={<Button variant="secondary" onClick={() => setPurpose('Все')}>Показать все</Button>} /> : <Card className="stock-journal"><table className="stock-table lots-table" aria-label="Журнал лотов">
      <thead><tr><th scope="col">Лот</th><th scope="col">Обжарка</th><th scope="col" className="stock-number">Вес</th><th scope="col">Готовность</th><th scope="col">Назначения</th><th scope="col"><span className="sr-only">Действие</span></th></tr></thead>
      <tbody>{visibleLots.map((lot) => {
        const tasks = data.productionTasks.filter((task) => task.lotId === lot.id)
        const purposes = [...new Set(data.allocations.filter((item) => item.lotId === lot.id).map((item) => item.purpose))]
        const today = format(new Date(), 'yyyy-MM-dd')
        const ready = tasks.some((task) => task.status === 'open' && task.approved && task.plannedDate <= today && (task.scheduleDecision !== 'bu' || task.inBU))
        const decision = tasks.some((task) => task.status === 'open' && (!task.approved || (task.scheduleDecision === 'bu' && !task.inBU)))
        const date = tasks.filter((task) => task.status === 'open').map((task) => task.plannedDate).sort()[0]
        return <tr className="inventory-row" key={lot.id} onClick={() => setSelected(lot.id)}>
          <th scope="row">{lot.country} / {lot.name}</th>
          <td className="stock-date"><span className="lot-cell-label">Обжарка</span><time dateTime={lot.roastDate}>{format(parseISO(lot.roastDate), 'dd.MM.yyyy')}</time></td>
          <td className="stock-number"><span>Вес</span>{formatNumber(lot.weightKg)} кг</td>
          <td className="stock-status"><span className="lot-cell-label">Готовность</span><Badge tone={ready ? 'success' : decision ? 'warning' : 'neutral'}>{ready ? 'Готов к фасовке' : decision ? 'Ждёт решения' : date ? format(parseISO(date), 'dd.MM.yyyy') : tasks.length ? 'Завершено' : 'Без задач'}</Badge></td>
          <td className="stock-destinations"><span className="lot-cell-label">Назначения</span><div className="lot-purpose-list">{purposes.length ? purposes.map((purpose) => <Badge key={purpose}>{purpose}</Badge>) : '—'}</div></td>
          <td className="stock-action"><Button size="sm" variant="secondary" aria-label={`Открыть лот ${lot.country} ${lot.name}`} onClick={(event) => { event.stopPropagation(); setSelected(lot.id) }}>Открыть</Button></td>
        </tr>
      })}</tbody>
    </table></Card>}
    {unlocked && (open || fromDashboard || editing) && <Modal title={editing ? "Редактировать лот" : "Новый лот"} onClose={() => { if (!busy) closeForm() }} wide>
      <form onSubmit={submit} className="grid gap-5">
        {metadataOnly && <p className="notice">У лота есть производственные операции. Можно исправить страну, название и комментарий.</p>}
        <div className="form-grid">
          <Field label="Страна"><Input required value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="Эфиопия" /></Field>
          <Field label="Название лота"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Гуджи" /></Field>
          {!metadataOnly && <>
          <Field label="Дата обжарки"><Input type="date" required value={form.roastDate} onChange={(e) => setForm({ ...form, roastDate: e.target.value })} /></Field>
          <Field label="Вес после обжарки, кг"><Input type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" required value={form.weightKg} onChange={(e) => { const value = e.target.value.replace(',', '.'); if (/^\d*\.?\d*$/.test(value)) updateLotWeight(value) }} /></Field>
          <Field label="Дегазация, дней"><Input type="number" min="1" max="5" step="1" required value={form.degassingDays} onChange={(e) => setForm({ ...form, degassingDays: Number(e.target.value) })} /></Field>
          <Field label="Ответственный"><select className="field-control" value={form.responsibleId} onChange={(e) => setForm({ ...form, responsibleId: e.target.value })}><option value="">Не выбран</option>{data.employees.filter((item) => item.active).map((employee) => <option key={employee.id} value={employee.id}>{employee.lastName} {employee.firstName}</option>)}</select></Field>
          </>}
        </div>
        <Field label="Комментарий"><Textarea value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} /></Field>
        {!metadataOnly && <div>
          <div className="mb-1 flex items-center justify-between gap-3"><h3 className="font-semibold">Дробление по назначениям</h3><Button type="button" variant="ghost" size="sm" onClick={() => setAllocations((current) => rebalance(form.weightKg, [...current, blankAllocation()]))}><Plus size={16} />Добавить назначение</Button></div>
          <p className="mb-4 text-xs text-muted">Вес поровну делится между назначениями. При ручном вводе остаток перераспределяется между остальными.</p>
          <div className="grid gap-4">{allocations.map((allocation, index) => {
            const coefficient = data.settings.formats.find((item) => item.id === allocation.formatId)?.coefficient ?? 1
            return <div className="allocation-row" key={index}>
              <label className="grid content-start gap-1.5 text-xs font-medium text-muted"><span>Формат / тара</span><select aria-label={`Формат ${index + 1}`} className="field-control" value={allocation.formatId} onChange={(e) => {
                const formatId = e.target.value as FormatId
                const purposes = purposesForFormat(formatId, data.settings.purposes)
                const purpose = formatId === 'mega' && purposes.includes('Мега') ? 'Мега' : purposes.includes(allocation.purpose) ? allocation.purpose : purposes[0]
                setAllocations(allocations.map((item, i) => i === index ? { ...item, formatId, purpose } : item))
              }}>{data.settings.formats.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="grid content-start gap-1.5 text-xs font-medium text-muted"><span>Назначение</span><select aria-label={`Назначение ${index + 1}`} className="field-control" value={allocation.purpose} onChange={(e) => setAllocations(allocations.map((item, i) => i === index ? { ...item, purpose: e.target.value } : item))}>{purposesForFormat(allocation.formatId, data.settings.purposes).map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="grid content-start gap-1.5 text-xs font-medium text-muted"><span>Вес, кг</span><Input aria-label={`Вес ${index + 1}`} type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" required value={allocation.weightKg} onChange={(e) => { const value = e.target.value.replace(',', '.'); if (/^\d*\.?\d*$/.test(value)) updateAllocationWeight(index, value) }} /></label>
              <label className="grid content-start gap-1.5 text-xs font-medium text-muted"><span>Дегазация, дней</span><Input aria-label={`Дегазация ${index + 1}`} type="number" min="1" max="5" step="1" placeholder={String(form.degassingDays)} value={allocation.degassingDays} onChange={(e) => setAllocations(allocations.map((item, i) => i === index ? { ...item, degassingDays: e.target.value } : item))} /></label>
              <div className="allocation-output"><span>План выпуска</span><strong>≈ {formatNumber(plannedOutput(Number(allocation.weightKg), coefficient))} шт.</strong><small>{formatNumber(coefficient * 1000)} г/шт.</small></div>
              <button type="button" className="icon-button self-center" aria-label="Удалить назначение" disabled={allocations.length === 1} onClick={() => setAllocations((current) => rebalance(form.weightKg, current.filter((_, i) => i !== index)))}><Trash2 size={17} /></button>
              <label className="col-span-full grid gap-1.5 text-xs font-medium text-muted"><span>Комментарий к назначению</span><Input aria-label={`Комментарий к назначению ${index + 1}`} value={allocation.comment} onChange={(e) => setAllocations(allocations.map((item, i) => i === index ? { ...item, comment: e.target.value } : item))} /></label>
            </div>
          })}</div>
          <p className="mt-3 text-xs text-muted">План выпуска = вес назначения ÷ вес одной единицы, с округлением вниз.</p>
          <div className="detail-line"><span>Распределено</span><strong>{formatNumber(allocatedWeight)} кг</strong></div>
          <div className="detail-line"><span>{weightDifference < -1e-9 ? 'Превышение веса' : 'Осталось распределить'}</span><strong>{formatNumber(Math.abs(weightDifference))} кг</strong></div>
          {weightError && <p className="text-sm text-danger" role="status">{weightError}</p>}
        </div>}
        <div className="modal-actions">
          <Button type="button" variant="ghost" disabled={busy} onClick={closeForm}>Отмена</Button>
          <Button disabled={busy || (!metadataOnly && Boolean(weightError))}>{busy ? 'Сохраняем…' : editing ? 'Сохранить изменения' : 'Создать лот и задачи'}</Button>
        </div>
      </form>
    </Modal>}
    {selectedLot && !editing && !deleteOpen && (!scheduleForm || !unlocked) && <Modal title={`${selectedLot.country} / ${selectedLot.name}`} onClose={() => setSelected(null)}>
      <div className="grid gap-4">
        <div className="detail-line"><span>Дата обжарки</span><time dateTime={selectedLot.roastDate}>{format(parseISO(selectedLot.roastDate), 'dd.MM.yyyy')}</time></div>
        <div className="detail-line"><span>Срок дегазации лота</span><strong>{selectedLot.degassingDays} дн.</strong></div>
        {selectedLot.comment && <p className="text-muted">{selectedLot.comment}</p>}
        {selectedAllocations.map((item) => {
          const formatItem = data.settings.formats.find(({ id }) => id === item.formatId)
          const task = data.productionTasks.find((task) => task.lotId === selectedLot.id && matchesTaskAllocation(task, item))
          const coefficient = task?.coefficientSnapshot ?? formatItem?.coefficient ?? 0
          return <div className="detail-line" key={item.id}>
            <div>
              <strong>{formatItem?.name}</strong>
              <p className="text-sm text-muted">{item.purpose} · дегазация {item.degassingDays ?? selectedLot.degassingDays} дн.</p>
              {item.comment && <p className="text-sm text-muted">{item.comment}</p>}
            </div>
            <span>{formatNumber(item.weightKg)} кг · ≈ {formatNumber(plannedOutput(item.weightKg, coefficient))} шт.</span>
          </div>
        })}
        <div className="detail-line"><span>Нераспределённый остаток</span><strong>{formatNumber(Math.max(0, selectedLot.weightKg - selectedAllocations.reduce((sum, item) => sum + item.weightKg, 0)))} кг</strong></div>
        <section>
          <h3 className="mb-2 font-semibold">Связанные задачи</h3>
          {data.productionTasks.filter((task) => task.lotId === selectedLot.id).map((task) => <div className="detail-line" key={task.id}>
            <Link className="button button-secondary button-sm" to={`/production?task=${task.id}`}>{[data.settings.formats.find((item) => item.id === task.formatId)?.name ?? 'Задача производства', task.purpose].filter(Boolean).join(' / ')}</Link>
            {task.inBU && <Badge tone="warning">Находится в Б/у</Badge>}
            <time dateTime={task.plannedDate}>{format(parseISO(task.plannedDate), 'dd.MM.yyyy')}</time>
          </div>)}
        </section>
        {unlocked && <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={openEdit}>Редактировать лот</Button>
          <Button variant="danger" disabled={hasActivity || Boolean(linkedComposition)} onClick={() => setDeleteOpen(true)}>Удалить лот</Button>
        </div>}
        {unlocked && hasActivity && <p className="text-sm text-muted">Удаление недоступно: у лота есть производственные операции или партии на стоке.</p>}
        {unlocked && !hasActivity && linkedComposition && <p className="text-sm text-muted">Для удаления сначала замените лот в составе «{linkedComposition.name}».</p>}
        {unlocked && <Button variant="secondary" onClick={() => {
          setScheduleForm({ days: selectedLot.degassingDays, byAllocation: Object.fromEntries(selectedAllocations.map((item) => [item.id, String(item.degassingDays ?? '')])) })
        }}>Изменить сроки дегазации</Button>}
      </div>
    </Modal>}
    {unlocked && selectedLot && deleteOpen && <Modal title="Удалить лот?" onClose={() => { if (!busy) setDeleteOpen(false) }}>
      <p className="mb-4">Будут удалены лот «{selectedLot.country} / {selectedLot.name}», его назначения и задачи производства.</p>
      <div className="modal-actions"><Button variant="ghost" disabled={busy} onClick={() => setDeleteOpen(false)}>Отмена</Button>
        <Button variant="danger" disabled={busy} onClick={remove}>Удалить лот</Button></div>
    </Modal>}
    {unlocked && selectedLot && scheduleForm && <Modal title="Изменить сроки дегазации" onClose={() => { if (!busy) setScheduleForm(null) }}>
      <form className="grid gap-4" onSubmit={async (event) => {
        event.preventDefault()
        if (!unlocked || busy) return
        setBusy(true)
        try {
          const overrides = Object.fromEntries(Object.entries(scheduleForm.byAllocation).map(([id, value]) => [id, value ? Number(value) : undefined]))
          await updateLotDegassing(selectedLot.id, scheduleForm.days, overrides)
          toast.success('Сроки дегазации изменены')
          setScheduleForm(null)
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Не удалось изменить сроки')
        } finally {
          setBusy(false)
        }
      }}>
        <Field label="Общий срок, дней"><Input type="number" min="1" max="5" step="1" required value={scheduleForm.days} onChange={(e) => setScheduleForm({ ...scheduleForm, days: Number(e.target.value) })} /></Field>
        {selectedAllocations.map((item) => <Field key={item.id} label={`${item.purpose} · ${formatNumber(item.weightKg)} кг`}>
          <Input type="number" min="1" max="5" step="1" placeholder={String(scheduleForm.days)} value={scheduleForm.byAllocation[item.id] ?? ''} onChange={(e) => setScheduleForm({ ...scheduleForm, byAllocation: { ...scheduleForm.byAllocation, [item.id]: e.target.value } })} />
        </Field>)}
        <p className="text-sm text-muted">Пустое поле назначения использует общий срок. Изготовление одного формата планируется после готовности всех его назначений.</p>
        <div className="modal-actions"><Button type="button" variant="ghost" disabled={busy} onClick={() => setScheduleForm(null)}>Отмена</Button><Button disabled={busy}>Сохранить сроки</Button></div>
      </form>
    </Modal>}
  </>
}
