import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { Link, useSearchParams } from 'react-router'
import { useAppData } from '@/hooks/useAppData'
import { createLot } from '@/persistence/repository'
import { formatNumber, plannedOutput } from '@/domain/calculations'
import type { FormatId } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

const blankAllocation = (weightKg = '5') => ({ formatId: 'drip' as FormatId, purpose: '×16', weightKg, degassingDays: 3, comment: '' })

export default function LotsPage() {
  const data = useAppData()
  const { unlocked, requestUnlock } = useAdmin()
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const fromDashboard = params.has('new')
  const closeForm = () => { setOpen(false); if (fromDashboard) setParams({}, { replace: true }) }
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [purpose, setPurpose] = useState('Все')
  const [sort, setSort] = useState('newest')
  const [form, setForm] = useState({ country: '', name: '', roastDate: format(new Date(), 'yyyy-MM-dd'), weightKg: '5', degassingDays: 3, responsibleId: '', comment: '' })
  const [allocations, setAllocations] = useState([blankAllocation()])
  const selectedLot = data.lots.find((lot) => lot.id === selected)

  const openForm = () => { if (!unlocked) { requestUnlock(); return } setOpen(true) }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      await createLot({ ...form, weightKg: Number(form.weightKg), responsibleId: form.responsibleId || undefined, allocations: allocations.map((item) => ({ ...item, weightKg: Number(item.weightKg) })) })
      toast.success('Лот и задачи изготовления созданы')
      closeForm()
      setForm({ ...form, country: '', name: '', comment: '' }); setAllocations([blankAllocation(form.weightKg)])
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Не удалось создать лот') } finally { setBusy(false) }
  }
  const allocatedWeight = allocations.reduce((sum, item) => sum + Number(item.weightKg), 0)
  const weightDifference = Number(form.weightKg) - allocatedWeight
  const updateLotWeight = (weightKg: string) => {
    setForm({ ...form, weightKg })
    if (allocations.length === 1) setAllocations([{ ...allocations[0], weightKg }])
  }
  const visibleLots = data.lots
    .filter((lot) => purpose === 'Все' || data.allocations.some((item) => item.lotId === lot.id && item.purpose === purpose))
    .sort((a, b) => sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : sort === 'weight' ? b.weightKg - a.weightKg : b.createdAt.localeCompare(a.createdAt))
  const totalWeight = data.lots.reduce((sum, lot) => sum + lot.weightKg, 0)

  return <>
    <PageHeader title="Лоты кофе" description={`${data.lots.length} лотов · всего ${formatNumber(totalWeight)} кг после обжарки`} action={<Button onClick={openForm}><Plus size={18} />Новый лот</Button>} />
    <div className="filter-pills" aria-label="Фильтры лотов">
      {['Все', ...data.settings.purposes].map((item) => <button type="button" key={item} className={purpose === item ? 'active' : ''} aria-pressed={purpose === item} onClick={() => setPurpose(item)}>{item}</button>)}
      <select className="field-control" aria-label="Сортировка лотов" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option><option value="weight">По убыванию веса</option></select>
    </div>
    {data.lots.length === 0 ? <Empty title="Пока нет лотов" text="Зарегистрируйте первый обжаренный лот — система рассчитает выход и производственные даты." action={<Button onClick={openForm}>Создать лот</Button>} /> : visibleLots.length === 0 ? <Empty title="Лотов с таким назначением нет" text="Выберите другой фильтр, чтобы увидеть доступные лоты." action={<Button variant="secondary" onClick={() => setPurpose('Все')}>Показать все</Button>} /> : <Card className="stock-journal"><table className="stock-table" aria-label="Журнал лотов">
      <thead><tr><th scope="col">Лот</th><th scope="col">Обжарка</th><th scope="col">Вес</th><th scope="col">Готовность</th><th scope="col">Назначения</th><th scope="col"><span className="sr-only">Действие</span></th></tr></thead>
      <tbody>{visibleLots.map((lot) => {
        const tasks = data.productionTasks.filter((task) => task.lotId === lot.id)
        const purposes = [...new Set(data.allocations.filter((item) => item.lotId === lot.id).map((item) => item.purpose))]
        const today = format(new Date(), 'yyyy-MM-dd')
        const ready = tasks.some((task) => task.status === 'open' && task.approved && task.plannedDate <= today && (task.scheduleDecision !== 'bu' || task.inBU))
        const decision = tasks.some((task) => task.status === 'open' && (!task.approved || (task.scheduleDecision === 'bu' && !task.inBU)))
        const date = tasks.filter((task) => task.status === 'open').map((task) => task.plannedDate).sort()[0]
        return <tr className="inventory-row" key={lot.id} onClick={() => setSelected(lot.id)}>
          <th scope="row">{lot.country} / {lot.name}</th>
          <td className="stock-date"><time dateTime={lot.roastDate}>{format(parseISO(lot.roastDate), 'dd.MM.yyyy')}</time></td>
          <td className="stock-number"><span>Вес</span>{formatNumber(lot.weightKg)} кг</td>
          <td className="stock-status"><Badge tone={ready ? 'success' : decision ? 'warning' : 'neutral'}>{ready ? 'Готов к фасовке' : decision ? 'Ждёт решения' : date ? format(parseISO(date), 'dd.MM.yyyy') : tasks.length ? 'Завершено' : 'Без задач'}</Badge></td>
          <td className="stock-destinations">{purposes.join(', ') || '—'}</td>
          <td className="stock-action"><Button size="sm" variant="secondary" aria-label={`Открыть лот ${lot.country} ${lot.name}`} onClick={(event) => { event.stopPropagation(); setSelected(lot.id) }}>Открыть</Button></td>
        </tr>
      })}</tbody>
    </table></Card>}
    {fromDashboard && !unlocked && <div className="notice mb-4">Создание лота доступно администратору. <Button size="sm" onClick={requestUnlock}>Войти</Button></div>}
    {(open || (fromDashboard && unlocked)) && <Modal title="Новый лот" onClose={closeForm} wide>
      <form onSubmit={submit} className="grid gap-5">
        <p className="-mt-1 text-sm text-muted">Обжарка, дробление по назначениям и расчёт выхода по коэффициенту.</p>
        <div className="form-grid">
          <Field label="Страна"><Input required value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="Эфиопия" /></Field>
          <Field label="Название лота"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Гуджи" /></Field>
          <Field label="Дата обжарки"><Input type="date" required value={form.roastDate} onChange={(e) => setForm({ ...form, roastDate: e.target.value })} /></Field>
          <Field label="Вес после обжарки, кг"><Input type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" required value={form.weightKg} onChange={(e) => { const value = e.target.value.replace(',', '.'); if (/^\d*\.?\d*$/.test(value)) updateLotWeight(value) }} /></Field>
          <Field label="Дегазация, дней"><Input type="number" min="1" max="5" step="1" required value={form.degassingDays} onChange={(e) => { const days = Number(e.target.value); setForm({ ...form, degassingDays: days }); setAllocations(allocations.map((item) => ({ ...item, degassingDays: days }))) }} /></Field>
          <Field label="Ответственный"><select className="field-control" value={form.responsibleId} onChange={(e) => setForm({ ...form, responsibleId: e.target.value })}><option value="">Не выбран</option>{data.employees.filter((item) => item.active).map((employee) => <option key={employee.id} value={employee.id}>{employee.lastName} {employee.firstName}</option>)}</select></Field>
        </div>
        <Field label="Комментарий"><Textarea value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} /></Field>
        <div>
          <div className="mb-1 flex items-center justify-between gap-3"><h3 className="font-semibold">Дробление по назначениям</h3><Button type="button" variant="ghost" size="sm" onClick={() => setAllocations([...allocations, { ...blankAllocation(''), degassingDays: form.degassingDays }])}><Plus size={16} />Добавить назначение</Button></div>
          <p className="mb-4 text-xs text-muted">При одном назначении весь вес распределяется автоматически.</p>
          <div className="grid gap-4">{allocations.map((allocation, index) => {
            const coefficient = data.settings.formats.find((item) => item.id === allocation.formatId)?.coefficient ?? 1
            return <div className="allocation-row" key={index}>
              <label className="grid content-start gap-1.5 text-xs font-medium text-muted"><span>Формат / тара</span><select aria-label={`Формат ${index + 1}`} className="field-control" value={allocation.formatId} onChange={(e) => setAllocations(allocations.map((item, i) => i === index ? { ...item, formatId: e.target.value as FormatId } : item))}>{data.settings.formats.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="grid content-start gap-1.5 text-xs font-medium text-muted"><span>Назначение</span><select aria-label={`Назначение ${index + 1}`} className="field-control" value={allocation.purpose} onChange={(e) => setAllocations(allocations.map((item, i) => i === index ? { ...item, purpose: e.target.value } : item))}>{data.settings.purposes.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="grid content-start gap-1.5 text-xs font-medium text-muted"><span>Вес, кг</span><Input aria-label={`Вес ${index + 1}`} type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" required value={allocation.weightKg} onChange={(e) => { const value = e.target.value.replace(',', '.'); if (/^\d*\.?\d*$/.test(value)) setAllocations(allocations.map((item, i) => i === index ? { ...item, weightKg: value } : item)) }} /></label>
              <label className="grid content-start gap-1.5 text-xs font-medium text-muted"><span>Дегазация, дней</span><Input aria-label={`Дегазация ${index + 1}`} type="number" min="1" max="5" value={allocation.degassingDays} onChange={(e) => setAllocations(allocations.map((item, i) => i === index ? { ...item, degassingDays: Number(e.target.value) } : item))} /></label>
              <div className="allocation-output"><span>План выпуска</span><strong>≈ {formatNumber(plannedOutput(Number(allocation.weightKg), coefficient))} шт.</strong><small>{formatNumber(coefficient * 1000)} г/шт.</small></div>
              <button type="button" className="icon-button self-center" aria-label="Удалить назначение" onClick={() => setAllocations(allocations.filter((_, i) => i !== index))}><Trash2 size={17} /></button>
            </div>
          })}</div>
          <p className="mt-3 text-xs text-muted">План выпуска = вес назначения ÷ вес одной единицы, с округлением вниз.</p>
          <div className="detail-line"><span>Распределено</span><strong>{formatNumber(allocatedWeight)} кг</strong></div>
          <div className="detail-line"><span>{weightDifference < -1e-9 ? 'Превышение веса' : 'Осталось распределить'}</span><strong>{formatNumber(Math.abs(weightDifference))} кг</strong></div>
        </div>
        <div className="modal-actions"><Button type="button" variant="ghost" onClick={closeForm}>Отмена</Button><Button disabled={busy}>{busy ? 'Сохраняем…' : 'Создать лот и задачи'}</Button></div>
      </form>
    </Modal>}
    {selectedLot && <Modal title={`${selectedLot.country} / ${selectedLot.name}`} onClose={() => setSelected(null)}><div className="grid gap-4"><p className="text-muted">{selectedLot.comment || 'Комментарий не указан'}</p>{data.allocations.filter((item) => item.lotId === selectedLot.id).map((item) => <div className="detail-line" key={item.id}><div><strong>{data.settings.formats.find((formatItem) => formatItem.id === item.formatId)?.name}</strong><p className="text-sm text-muted">{item.purpose} · дегазация {item.degassingDays ?? selectedLot.degassingDays} дн.</p></div><span>{item.weightKg} кг</span></div>)}<section><h3 className="mb-2 font-semibold">Связанные задачи</h3>{data.productionTasks.filter((task) => task.lotId === selectedLot.id).map((task) => <div className="detail-line" key={task.id}><Link className="button button-secondary button-sm" to={`/production?task=${task.id}`}>{data.settings.formats.find((item) => item.id === task.formatId)?.name ?? 'Задача производства'}</Link><time dateTime={task.plannedDate}>{format(parseISO(task.plannedDate), 'dd.MM.yyyy')}</time></div>)}</section><div className="detail-line"><span>Код лота</span><code className="text-xs">{selectedLot.id}</code></div></div></Modal>}
  </>
}
