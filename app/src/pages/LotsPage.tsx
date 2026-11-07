import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { useAppData } from '@/hooks/useAppData'
import { createLot } from '@/persistence/repository'
import { formatNumber, plannedOutput } from '@/domain/calculations'
import type { FormatId } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

const blankAllocation = (weightKg = '5') => ({ formatId: 'drip' as FormatId, purpose: '×16', weightKg, degassingDays: 3, comment: '' })

export default function LotsPage() {
  const data = useAppData()
  const { unlocked, requestUnlock } = useAdmin()
  const [open, setOpen] = useState(false)
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
      setOpen(false)
      setForm({ ...form, country: '', name: '', comment: '' }); setAllocations([blankAllocation(form.weightKg)])
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Не удалось создать лот') } finally { setBusy(false) }
  }
  const allocated = (lotId: string) => data.allocations.filter((item) => item.lotId === lotId).reduce((sum, item) => sum + item.weightKg, 0)
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
    {data.lots.length === 0 ? <Empty title="Пока нет лотов" text="Зарегистрируйте первый обжаренный лот — система рассчитает выход и производственные даты." action={<Button onClick={openForm}>Создать лот</Button>} /> : visibleLots.length === 0 ? <Empty title="Лотов с таким назначением нет" text="Выберите другой фильтр, чтобы увидеть доступные лоты." action={<Button variant="secondary" onClick={() => setPurpose('Все')}>Показать все</Button>} /> : <div className="card-grid">{visibleLots.map((lot) => {
      const allocatedWeight = allocated(lot.id)
      const tasks = data.productionTasks.filter((task) => task.lotId === lot.id)
      const output = tasks.reduce((sum, task) => sum + task.plannedQuantity, 0)
      const responsible = data.employees.find((employee) => employee.id === lot.responsibleId)
      return <Card className="lot-card" key={lot.id}><button className="w-full text-left" onClick={() => setSelected(lot.id)} aria-label={`Открыть лот ${lot.country} ${lot.name}`}>
        <div className="lot-card-top"><div><p className="eyebrow">{lot.country}</p><h2 className="card-title">{lot.name}</h2></div><span className="lot-weight">{formatNumber(lot.weightKg)} кг</span></div>
        <p className="lot-meta">Обжарен {format(new Date(lot.roastDate), 'dd.MM.yyyy')} · дегазация {lot.degassingDays} дн.</p>
        <div className="lot-allocation"><span>Распределено</span><strong>{formatNumber(Number(allocatedWeight.toFixed(2)))} / {formatNumber(lot.weightKg)} кг</strong></div>
        <div className="progress-track" role="progressbar" aria-label={`Распределение лота ${lot.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, allocatedWeight / Math.max(lot.weightKg, 0.0001) * 100))}><div className="progress-value" style={{ width: `${Math.min(100, allocatedWeight / Math.max(lot.weightKg, 0.0001) * 100)}%` }} /></div>
        <div className="lot-footer"><span>Выход по плану: {formatNumber(output)} шт.</span><span>{tasks.length} задач{responsible ? ` · ${responsible.firstName[0]}${responsible.lastName[0]}` : ''}</span></div>
      </button></Card>
    })}</div>}
    {open && <Modal title="Новый лот" onClose={() => setOpen(false)} wide>
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
          <p className="mt-2 text-sm text-muted">Нераспределённый остаток: <strong>{Math.max(0, Number(form.weightKg) - allocations.reduce((sum, item) => sum + Number(item.weightKg), 0)).toFixed(2)} кг</strong></p>
        </div>
        <div className="modal-actions"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Отмена</Button><Button disabled={busy}>{busy ? 'Сохраняем…' : 'Создать лот и задачи'}</Button></div>
      </form>
    </Modal>}
    {selectedLot && <Modal title={`${selectedLot.country} / ${selectedLot.name}`} onClose={() => setSelected(null)}><div className="grid gap-4"><p className="text-muted">{selectedLot.comment || 'Комментарий не указан'}</p>{data.allocations.filter((item) => item.lotId === selectedLot.id).map((item) => <div className="detail-line" key={item.id}><div><strong>{data.settings.formats.find((formatItem) => formatItem.id === item.formatId)?.name}</strong><p className="text-sm text-muted">{item.purpose} · дегазация {item.degassingDays ?? selectedLot.degassingDays} дн.</p></div><span>{item.weightKg} кг</span></div>)}<div className="detail-line"><span>Внутренний UUID</span><code className="text-xs">{selectedLot.id}</code></div></div></Modal>}
  </>
}
