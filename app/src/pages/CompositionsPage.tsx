import { useState } from 'react'
import { Link2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppData } from '@/hooks/useAppData'
import { db } from '@/persistence/db'
import { addManualComposition, saveAlias, saveImportedCompositions, toggleComposition } from '@/persistence/repository'
import { compositionCapacity, uid } from '@/domain/calculations'
import { fetchSheetCsv, listPublicSheets, parseCompositionSheet } from '@/integrations/googleSheets'
import type { CompositionItem, FormatId, ManualComposition } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

const emptyItem = (): CompositionItem => ({ id: uid(), country: '', coffeeName: '', formatId: 'drip', quantityPerSet: 6 })

export default function CompositionsPage() {
  const data = useAppData(); const { unlocked, requestUnlock } = useAdmin()
  const [tab, setTab] = useState<'all' | 'manual' | 'google'>('all'); const [manualOpen, setManualOpen] = useState(false)
  const [name, setName] = useState(''); const [kind, setKind] = useState<ManualComposition['kind']>('x6'); const [items, setItems] = useState<CompositionItem[]>([emptyItem()])
  const [url, setUrl] = useState(''); const [connectionId, setConnectionId] = useState(''); const [sheets, setSheets] = useState<Array<{ name: string; gid: string }>>([]); const [selectedSheets, setSelectedSheets] = useState<string[]>([]); const [loading, setLoading] = useState(false)
  const [csv, setCsv] = useState(''); const [csvName, setCsvName] = useState('×16')
  const compositions = [...data.importedCompositions, ...data.manualCompositions]
  const requireAdmin = (action: () => void) => unlocked ? action() : requestUnlock()
  const changeKind = (value: ManualComposition['kind']) => {
    setKind(value)
    if (value === 'subscription') setItems(Array.from({ length: 6 }, () => ({ ...emptyItem(), quantityPerSet: 5 })))
    else setItems([{ ...emptyItem(), quantityPerSet: 6, formatId: value === 'mega6' ? 'mega' : 'drip' }])
  }
  const selectLot = (index: number, lotId: string) => {
    const lot = data.lots.find((item) => item.id === lotId)
    if (!lot) return
    setItems(items.map((item, i) => i === index ? { ...item, country: lot.country, coffeeName: lot.name, inventoryLotId: lot.id } : item))
  }
  const submitManual = async () => {
    try { await addManualComposition(name, kind, items); toast.success('Ручной состав сохранён'); setManualOpen(false); setName(''); setItems([emptyItem()]) } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка') }
  }
  const connect = async () => {
    setLoading(true)
    try { const list = await listPublicSheets(url); setSheets(list); setSelectedSheets(list.map((item) => `${item.name}::${item.gid}`)); let id = connectionId; if (!id) { id = uid(); setConnectionId(id); await db.sheetConnections.put({ id, url, selectedSheets: [] }) } else await db.sheetConnections.update(id, { url }); toast.success(`Найдено листов: ${list.length}`) } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка подключения') } finally { setLoading(false) }
  }
  const refresh = async () => {
    if (!connectionId || !selectedSheets.length) { toast.error('Сначала получите и выберите листы'); return }
    setLoading(true)
    try {
      const imported = []
      for (const selection of selectedSheets) {
        const [sheetName, gid] = selection.split('::')
        const text = await fetchSheetCsv(url, gid)
        imported.push(...parseCompositionSheet(text, sheetName, connectionId))
      }
      await saveImportedCompositions(connectionId, imported, selectedSheets)
      toast.success(`Обновлено составов: ${imported.length}`)
    } catch (error) { const message = error instanceof Error ? error.message : 'Ошибка импорта'; await db.sheetConnections.update(connectionId, { lastError: message }); await db.warnings.add({ id: uid(), type: 'import', message, read: false, createdAt: new Date().toISOString() }); toast.error(`${message}. Рабочие данные не изменены.`) } finally { setLoading(false) }
  }
  const importCsv = async () => {
    let id = connectionId
    try {
      if (!id) { id = uid(); setConnectionId(id); await db.sheetConnections.put({ id, url: 'Локальный CSV', selectedSheets: [csvName] }) }
      const imported = parseCompositionSheet(csv, csvName, id)
      await saveImportedCompositions(id, imported, [csvName]); toast.success(`Импортировано: ${imported.length}`)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка CSV') }
  }
  return <>
    <PageHeader title="Составы наборов" description="Google Sheets, ручные наборы и сопоставление со стоком" action={<Button onClick={() => requireAdmin(() => setManualOpen(true))}><Plus size={18} />Ручной состав</Button>} />
    <div className="tabs mb-5"><button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>Все составы <span>{compositions.length}</span></button><button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>Редактор</button><button className={tab === 'google' ? 'active' : ''} onClick={() => setTab('google')}>Google Sheets</button></div>
    {tab === 'all' && (!compositions.length ? <Empty title="Нет составов" text="Импортируйте ×16 или ×30 из Google Sheets либо создайте ручной набор." action={<Button onClick={() => setTab('google')}>Подключить таблицу</Button>} /> : <div className="card-grid">{compositions.map((composition) => { const capacity = compositionCapacity(composition.items, data.inventory); const imported = 'sheetConnectionId' in composition; return <Card key={composition.id}><div className="flex items-start justify-between gap-3"><div><p className="eyebrow">{composition.kind === 'x16' ? 'Google Sheets · ×16' : composition.kind === 'x30' ? 'Google Sheets · ×30' : composition.kind === 'mega6' ? 'Мега ×6' : composition.kind === 'subscription' ? 'Подписка' : composition.kind === 'x6' ? 'Дрип ×6' : 'Лимита'}</p><h2 className="card-title">{composition.name}</h2></div><Badge tone={composition.enabled ? 'success' : 'neutral'}>{composition.enabled ? 'Активен' : 'Отключён'}</Badge></div><div className="my-4 grid gap-2">{composition.items.map((item) => { const match = capacity.matches.find((entry) => entry.item.id === item.id); return <div className="composition-item" key={item.id}><div><strong>{item.country} / {item.coffeeName}</strong><p>{item.quantityPerSet} пакетов · доступно {match?.available ?? 0}</p>{!match?.matched && <span className="text-xs text-danger">Не сопоставлен со стоком</span>}</div>{imported && !match?.matched && <select aria-label={`Сопоставить ${item.coffeeName}`} className="field-control compact" value="" onChange={(e) => e.target.value && saveAlias(item.country, item.coffeeName, e.target.value).then(() => toast.success('Псевдоним сохранён'))}><option value="">Выбрать лот…</option>{data.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.country} / {lot.name}</option>)}</select>}</div>})}</div><div className="flex items-end justify-between gap-3 border-t border-border pt-4"><div><span className="text-sm text-muted">Можно собрать</span><strong className="block text-2xl">{composition.enabled ? capacity.maximum : '—'} наборов</strong>{capacity.limiting && <small className="text-muted">Лимит: {capacity.limiting.item.coffeeName}</small>}</div><Button variant="secondary" size="sm" onClick={() => requireAdmin(() => toggleComposition(composition.id, imported).catch((e) => toast.error(e.message)))}>{composition.enabled ? 'Отключить' : 'Включить'}</Button></div></Card>})}</div>)}
    {tab === 'manual' && <Card><h2 className="card-title">Ручные форматы</h2><p className="mt-2 max-w-2xl text-muted">×6 — шесть дрипов одного лота; Мега ×6 — шесть пакетов Мега; Подписка — шесть лотов по пять дрипов; Лимита — произвольные позиции и количество.</p><Button className="mt-5" onClick={() => requireAdmin(() => setManualOpen(true))}>Создать ручной состав</Button></Card>}
    {tab === 'google' && <div className="grid gap-5"><Card><div className="mb-4"><h2 className="card-title">Публичная Google Sheets</h2><p className="mt-1 text-sm text-muted">Доступ «всем, у кого есть ссылка» только для чтения. Приватный сервисный ключ не нужен.</p></div><Field label="Ссылка на таблицу"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></Field><Button className="mt-4" variant="secondary" disabled={loading} onClick={() => requireAdmin(connect)}><Link2 size={17} />{loading ? 'Загрузка…' : 'Получить листы'}</Button>{sheets.length > 0 && <div className="mt-5 grid gap-2"><h3 className="font-semibold">Листы для импорта</h3>{sheets.map((sheet) => { const value = `${sheet.name}::${sheet.gid}`; return <label className="check-filter" key={sheet.gid}><input type="checkbox" checked={selectedSheets.includes(value)} onChange={(e) => setSelectedSheets(e.target.checked ? [...selectedSheets, value] : selectedSheets.filter((item) => item !== value))} />{sheet.name}</label>})}<Button disabled={loading} onClick={() => requireAdmin(refresh)}><RefreshCw size={17} />Обновить составы</Button></div>}{data.sheetConnections[0]?.lastSuccessAt && <p className="mt-4 text-sm text-muted">Последний успешный снимок: {new Date(data.sheetConnections[0].lastSuccessAt!).toLocaleString('ru-RU')}</p>}</Card><Card><h2 className="card-title">Проверка или локальный импорт CSV</h2><p className="mb-4 mt-1 text-sm text-muted">Формат: первая строка — названия наборов, первая колонка — «Страна 1 / локация 1» и следующие строки лотов.</p><div className="form-grid"><Field label="Тип / имя листа"><select className="field-control" value={csvName} onChange={(e) => setCsvName(e.target.value)}><option>×16</option><option>×30</option></select></Field></div><Field label="CSV-данные"><Textarea className="min-h-36 font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'Набор,Восточная коллекция\nСтрана 1 / локация 1,Эфиопия / Гуджи\nСтрана 2 / локация 2,Колумбия / Уила\nСтрана 3 / локация 3,Бразилия / Серрадо\nСтрана 4 / локация 4,Кения / Ньери'} /></Field><Button className="mt-4" variant="secondary" onClick={() => requireAdmin(importCsv)}>Импортировать CSV</Button></Card></div>}
    {manualOpen && <Modal title="Новый ручной состав" onClose={() => setManualOpen(false)} wide><div className="grid gap-4"><div className="form-grid"><Field label="Название"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Набор выходного дня" /></Field><Field label="Тип"><select className="field-control" value={kind} onChange={(e) => changeKind(e.target.value as ManualComposition['kind'])}><option value="x6">Обычный дрип ×6</option><option value="mega6">Мега ×6</option><option value="subscription">Подписка (6 × 5)</option><option value="limit">Лимита</option></select></Field></div><div className="grid gap-3">{items.map((item, index) => <div className="manual-item" key={item.id}><select aria-label={`Лот состава ${index + 1}`} className="field-control" value={item.inventoryLotId ?? ''} onChange={(e) => selectLot(index, e.target.value)}><option value="">Выберите лот</option>{data.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.country} / {lot.name}</option>)}</select><select aria-label={`Формат состава ${index + 1}`} className="field-control" disabled={kind !== 'limit'} value={item.formatId} onChange={(e) => setItems(items.map((entry, i) => i === index ? { ...entry, formatId: e.target.value as FormatId } : entry))}>{data.settings.formats.filter((formatItem) => formatItem.id === 'drip' || formatItem.id === 'mega').map((formatItem) => <option key={formatItem.id} value={formatItem.id}>{formatItem.name}</option>)}</select><Input aria-label={`Пакетов в наборе ${index + 1}`} type="number" min="1" step="1" disabled={kind !== 'limit'} value={item.quantityPerSet} onChange={(e) => setItems(items.map((entry, i) => i === index ? { ...entry, quantityPerSet: Number(e.target.value) } : entry))} />{(kind === 'limit') && <button className="icon-button" aria-label="Удалить позицию" onClick={() => setItems(items.filter((_, i) => i !== index))}><Trash2 size={17} /></button>}</div>)}</div>{kind === 'limit' && <Button variant="ghost" onClick={() => setItems([...items, { ...emptyItem(), quantityPerSet: 1 }])}><Plus size={16} />Добавить позицию</Button>}<Button onClick={submitManual}>Сохранить состав</Button></div></Modal>}
  </>
}
