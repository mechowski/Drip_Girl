import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { useAppData } from '@/hooks/useAppData'
import { createLot } from '@/persistence/repository'
import { formatNumber, plannedOutput } from '@/domain/calculations'
import type { FormatId } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

const blankAllocation = () => ({ formatId: 'drip' as FormatId, purpose: '×16', weightKg: 1, degassingDays: 3, comment: '' })

export default function LotsPage() {
  const data = useAppData()
  const { unlocked, requestUnlock } = useAdmin()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ country: '', name: '', roastDate: format(new Date(), 'yyyy-MM-dd'), weightKg: 5, degassingDays: 3, responsibleId: '', comment: '' })
  const [allocations, setAllocations] = useState([blankAllocation()])
  const selectedLot = data.lots.find((lot) => lot.id === selected)

  const openForm = () => { if (!unlocked) { requestUnlock(); return } setOpen(true) }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      await createLot({ ...form, responsibleId: form.responsibleId || undefined, allocations })
      toast.success('Лот и задачи изготовления созданы')
      setOpen(false)
      setForm({ ...form, country: '', name: '', comment: '' }); setAllocations([blankAllocation()])
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Не удалось создать лот') } finally { setBusy(false) }
  }
  const allocated = (lotId: string) => data.allocations.filter((item) => item.lotId === lotId).reduce((sum, item) => sum + item.weightKg, 0)

  return <>
    <PageHeader title="Лоты кофе" description="Обжарка, распределение по назначениям и расчёт выхода" action={<Button onClick={openForm}><Plus size={18} />Новый лот</Button>} />
    {data.lots.length === 0 ? <Empty title="Пока нет лотов" text="Зарегистрируйте первый обжаренный лот — система рассчитает выход и производственные даты." action={<Button onClick={openForm}>Создать лот</Button>} /> : <div className="card-grid">{data.lots.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((lot) => <Card key={lot.id}><button className="w-full text-left" onClick={() => setSelected(lot.id)}><div className="flex items-start justify-between gap-3"><div><p className="eyebrow">{lot.country}</p><h2 className="card-title">{lot.name}</h2></div><Badge tone="accent">{lot.weightKg} кг</Badge></div><dl className="metric-row"><div><dt>Обжарен</dt><dd>{format(new Date(lot.roastDate), 'dd.MM.yyyy')}</dd></div><div><dt>Распределено</dt><dd>{allocated(lot.id).toFixed(2)} кг</dd></div><div><dt>Остаток</dt><dd>{Math.max(0, lot.weightKg - allocated(lot.id)).toFixed(2)} кг</dd></div></dl><p className="mt-4 text-sm text-muted">Дегазация {lot.degassingDays} дн. · задач: {data.productionTasks.filter((task) => task.lotId === lot.id).length}</p></button></Card>)}</div>}
    {open && <Modal title="Регистрация лота" onClose={() => setOpen(false)} wide><form onSubmit={submit} className="grid gap-5"><div className="form-grid"><Field label="Страна"><Input required value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="Эфиопия" /></Field><Field label="Название лота"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Гуджи" /></Field><Field label="Дата обжарки"><Input type="date" required value={form.roastDate} onChange={(e) => setForm({ ...form, roastDate: e.target.value })} /></Field><Field label="Вес после обжарки, кг"><Input type="number" min="0.01" step="0.01" required value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: Number(e.target.value) })} /></Field><Field label="Дегазация, дней"><Input type="number" min="1" max="5" step="1" required value={form.degassingDays} onChange={(e) => { const days = Number(e.target.value); setForm({ ...form, degassingDays: days }); setAllocations(allocations.map((item) => ({ ...item, degassingDays: days }))) }} /></Field><Field label="Ответственный"><select className="field-control" value={form.responsibleId} onChange={(e) => setForm({ ...form, responsibleId: e.target.value })}><option value="">Не выбран</option>{data.employees.filter((item) => item.active).map((employee) => <option key={employee.id} value={employee.id}>{employee.lastName} {employee.firstName}</option>)}</select></Field></div><Field label="Комментарий"><Textarea value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} /></Field><div><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">Дробление лота</h3><Button type="button" variant="secondary" size="sm" onClick={() => setAllocations([...allocations, { ...blankAllocation(), degassingDays: form.degassingDays }])}><Plus size={16} />Добавить</Button></div><div className="grid gap-3">{allocations.map((allocation, index) => { const coefficient = data.settings.formats.find((item) => item.id === allocation.formatId)?.coefficient ?? 1; return <div className="allocation-row" key={index}><select aria-label={`Формат ${index + 1}`} className="field-control" value={allocation.formatId} onChange={(e) => setAllocations(allocations.map((item, i) => i === index ? { ...item, formatId: e.target.value as FormatId } : item))}>{data.settings.formats.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select aria-label={`Назначение ${index + 1}`} className="field-control" value={allocation.purpose} onChange={(e) => setAllocations(allocations.map((item, i) => i === index ? { ...item, purpose: e.target.value } : item))}>{data.settings.purposes.map((purpose) => <option key={purpose}>{purpose}</option>)}</select><Input aria-label={`Вес ${index + 1}`} type="number" min="0.01" step="0.01" value={allocation.weightKg} onChange={(e) => setAllocations(allocations.map((item, i) => i === index ? { ...item, weightKg: Number(e.target.value) } : item))} /><Input aria-label={`Дегазация ${index + 1}`} type="number" min="1" max="5" value={allocation.degassingDays} onChange={(e) => setAllocations(allocations.map((item, i) => i === index ? { ...item, degassingDays: Number(e.target.value) } : item))} /><span className="self-center text-sm text-muted">≈ {formatNumber(plannedOutput(allocation.weightKg, coefficient))} шт.</span><button type="button" className="icon-button self-center" aria-label="Удалить назначение" onClick={() => setAllocations(allocations.filter((_, i) => i !== index))}><Trash2 size={17} /></button></div>})}</div><p className="mt-3 text-sm text-muted">Нераспределённый остаток: <strong>{Math.max(0, form.weightKg - allocations.reduce((sum, item) => sum + item.weightKg, 0)).toFixed(2)} кг</strong></p></div><div className="modal-actions"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Отмена</Button><Button disabled={busy}>{busy ? 'Сохраняем…' : 'Создать лот и задачи'}</Button></div></form></Modal>}
    {selectedLot && <Modal title={`${selectedLot.country} / ${selectedLot.name}`} onClose={() => setSelected(null)}><div className="grid gap-4"><p className="text-muted">{selectedLot.comment || 'Комментарий не указан'}</p>{data.allocations.filter((item) => item.lotId === selectedLot.id).map((item) => <div className="detail-line" key={item.id}><div><strong>{data.settings.formats.find((formatItem) => formatItem.id === item.formatId)?.name}</strong><p className="text-sm text-muted">{item.purpose} · дегазация {item.degassingDays ?? selectedLot.degassingDays} дн.</p></div><span>{item.weightKg} кг</span></div>)}<div className="detail-line"><span>Внутренний UUID</span><code className="text-xs">{selectedLot.id}</code></div></div></Modal>}
  </>
}
