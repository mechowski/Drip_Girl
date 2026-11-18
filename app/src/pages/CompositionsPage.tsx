import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { Link2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppData, type AppData } from '@/hooks/useAppData'
import { addManualComposition, saveAlias, saveImportedCompositions, toggleComposition, updateManualComposition } from '@/persistence/compositions'
import { compositionCapacity, exactCoffeeKey, uid } from '@/domain/calculations'
import { listPublicSheets, parseCompositionSheet, spreadsheetId, type PublicSheet } from '@/integrations/googleSheets'
import { currentSheetConnection, refreshPublicSheets, selectedPublicSheets, sheetSelection } from '@/integrations/sheetSync'
import type { CoffeeLot, CompositionItem, FormatId, ManualComposition, SheetConnection } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

const formatLabels = { x16: '×16', x30: '×30', mega6: 'Мега ×6', subscription: 'Подписка', x6: 'Дрип ×6', limit: 'Лимита' }
const localCsvName = 'Локальный CSV'
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

function newItems(kind: ManualComposition['kind']): CompositionItem[] {
  const length = kind === 'subscription' ? 6 : 1
  const quantity = kind === 'subscription' ? 5 : kind === 'limit' ? 1 : 6
  return Array.from({ length }, () => ({
    id: uid(), country: '', coffeeName: '', formatId: kind === 'mega6' ? 'mega' : 'drip', quantityPerSet: quantity,
  }))
}

function LotOptions({ lots }: { lots: CoffeeLot[] }) {
  const keys = lots.map((lot) => exactCoffeeKey(lot.country, lot.name))
  return lots.map((lot, index) => <option key={lot.id} value={lot.id}>
    {lot.country} / {lot.name}{keys.indexOf(keys[index]) !== keys.lastIndexOf(keys[index]) ? ` · ${lot.roastDate}` : ''}
  </option>)
}

function ManualForm({ composition, data, onClose }: { composition?: ManualComposition; data: AppData; onClose: (saved?: boolean) => void }) {
  const { unlocked, requestUnlock } = useAdmin()
  const [name, setName] = useState(composition?.name ?? '')
  const [kind, setKind] = useState<ManualComposition['kind']>(composition?.kind ?? 'x6')
  const [items, setItems] = useState(() => composition?.items ?? newItems('x6'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function updateItem(id: string, patch: Partial<CompositionItem>) {
    setItems((entries) => entries.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!unlocked) { requestUnlock(); return }
    setSaving(true)
    setError('')
    try {
      if (composition) await updateManualComposition(composition.id, name, kind, items)
      else await addManualComposition(name, kind, items)
      toast.success('Ручной состав сохранён')
      onClose(true)
    } catch (cause) {
      setError(errorMessage(cause, 'Не удалось сохранить состав'))
    } finally {
      setSaving(false)
    }
  }

  return <Modal title={composition ? 'Редактирование состава' : 'Новый ручной состав'} onClose={() => onClose()} wide>
    <form onSubmit={submit} className="grid gap-4">
      <div className="form-grid">
        <Field label="Название"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Набор выходного дня" required /></Field>
        <Field label="Тип"><select className="field-control" value={kind} onChange={(event) => {
          const next = event.target.value as ManualComposition['kind']
          setKind(next)
          setItems(newItems(next))
        }}><option value="x6">Обычный дрип ×6</option><option value="mega6">Мега ×6</option><option value="subscription">Подписка (6 × 5)</option><option value="limit">Лимита</option></select></Field>
      </div>
      {!data.lots.length && <p className="text-sm text-muted">Зарегистрируйте кофе в разделе «Лоты», чтобы добавить его в состав.</p>}
      <div className="grid gap-3">{items.map((item, index) => <div className="manual-item" key={item.id}>
        <select aria-label={`Лот состава ${index + 1}`} className="field-control" required value={item.inventoryLotId ?? ''} onChange={(event) => {
          const lot = data.lots.find((entry) => entry.id === event.target.value)
          updateItem(item.id, { country: lot?.country ?? '', coffeeName: lot?.name ?? '', inventoryLotId: lot?.id })
        }}><option value="">Выберите лот</option><LotOptions lots={data.lots} /></select>
        <select aria-label={`Формат состава ${index + 1}`} className="field-control" disabled={kind !== 'limit'} value={item.formatId} onChange={(event) => updateItem(item.id, { formatId: event.target.value as FormatId })}>
          {data.settings.formats.filter((entry) => entry.id === 'drip' || entry.id === 'mega').map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        <Input aria-label={`Пакетов в наборе ${index + 1}`} type="number" min="1" step="1" required disabled={kind !== 'limit'} value={item.quantityPerSet || ''} onChange={(event) => updateItem(item.id, { quantityPerSet: Number(event.target.value) })} />
        {kind === 'limit' && <button type="button" className="icon-button" aria-label={`Удалить позицию ${index + 1}`} onClick={() => setItems(items.filter((entry) => entry.id !== item.id))}><Trash2 size={17} /></button>}
      </div>)}</div>
      {kind === 'limit' && <Button type="button" variant="ghost" onClick={() => setItems([...items, ...newItems('limit')])}><Plus size={16} />Добавить позицию</Button>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <Button disabled={saving || !data.lots.length}>{saving ? 'Сохранение…' : 'Сохранить состав'}</Button>
    </form>
  </Modal>
}

function SheetImporter({ connection, csvConnection }: { connection?: SheetConnection; csvConnection?: SheetConnection }) {
  const { unlocked, requestUnlock } = useAdmin()
  const [draftUrl, setDraftUrl] = useState<string>()
  const [discovered, setDiscovered] = useState<{ url: string; sheets: PublicSheet[] }>()
  const [draftSelection, setDraftSelection] = useState<string[]>()
  const [loading, setLoading] = useState<'discover' | 'refresh' | 'csv'>()
  const [csv, setCsv] = useState('')
  const [csvName, setCsvName] = useState('×16')
  const [error, setError] = useState('')
  const url = draftUrl ?? connection?.url ?? ''
  const savedSheets = connection ? selectedPublicSheets(connection) : []
  const sheets = discovered?.url === url ? discovered.sheets : url === connection?.url ? connection.availableSheets ?? savedSheets : []
  const selectedSheets = draftSelection ?? connection?.selectedSheets ?? []
  const access = () => { if (!unlocked) requestUnlock(); return unlocked }

  async function connect() {
    if (!access()) return
    setLoading('discover')
    setError('')
    try {
      const list = await listPublicSheets(url)
      setDiscovered({ url, sheets: list })
      const same = connection ? spreadsheetId(url) === spreadsheetId(connection.url) : false
      const saved = new Set(savedSheets.map((sheet) => sheet.gid))
      const selection = list.filter((sheet) => same && saved.size ? saved.has(sheet.gid) : /(?:^|\D)(?:16|30)(?:\D|$)/.test(sheet.name))
      setDraftSelection(selection.map(sheetSelection))
      toast.success(`Найдено листов: ${list.length}`)
    } catch (cause) {
      setError(cause instanceof TypeError ? 'Не удалось прочитать таблицу. Проверьте сеть и доступ по ссылке' : errorMessage(cause, 'Ошибка подключения'))
    } finally {
      setLoading(undefined)
    }
  }

  async function refresh() {
    if (!access()) return
    setLoading('refresh')
    setError('')
    try {
      const count = await refreshPublicSheets({ id: connection?.id ?? uid(), url: url.trim(), selectedSheets, availableSheets: sheets }, connection ?? null)
      toast.success(`Обновлено составов: ${count}`)
    } catch (cause) {
      setError(`${errorMessage(cause, 'Ошибка импорта')}. Последние сохранённые составы доступны.`)
    } finally {
      setLoading(undefined)
    }
  }

  async function importCsv() {
    if (!access()) return
    setLoading('csv')
    try {
      const local = csvConnection ?? { id: uid(), url: localCsvName, selectedSheets: [] }
      const imported = parseCompositionSheet(csv, csvName, local.id)
      await saveImportedCompositions(local.id, imported, [csvName], { connection: local, expected: csvConnection ?? null, retainOtherSheets: true })
      toast.success(`Импортировано: ${imported.length}`)
    } catch (cause) {
      toast.error(errorMessage(cause, 'Ошибка CSV'))
    } finally {
      setLoading(undefined)
    }
  }

  return <div className="grid gap-5">
    <Card>
      <h2 className="card-title">Публичная Google Sheets</h2>
      <p className="mb-4 mt-1 text-sm text-muted">Разрешите чтение по ссылке или опубликуйте таблицу. Состав ×16 содержит четыре лота, состав ×30 три.</p>
      <Field label="Ссылка на таблицу"><Input type="url" value={url} disabled={Boolean(loading)} onChange={(event) => {
        setDraftUrl(event.target.value)
        setDraftSelection(undefined)
        setDiscovered(undefined)
        setError('')
      }} placeholder="https://docs.google.com/spreadsheets/d/…" /></Field>
      <Button className="mt-4" variant="secondary" disabled={Boolean(loading) || !url.trim()} onClick={connect}><Link2 size={17} />{loading === 'discover' ? 'Загрузка…' : 'Получить листы'}</Button>
      {sheets.length > 0 && <fieldset className="mt-5 grid gap-2">
        <legend className="mb-2 font-semibold">Листы для импорта</legend>
        {sheets.map((sheet) => {
          const key = sheetSelection(sheet)
          return <label className="check-filter" key={sheet.gid}><input type="checkbox" disabled={Boolean(loading)} checked={selectedSheets.includes(key)} onChange={(event) => {
            setDraftSelection(event.target.checked ? [...selectedSheets, key] : selectedSheets.filter((value) => value !== key))
          }} />{sheet.name}</label>
        })}
        <Button disabled={Boolean(loading) || !selectedSheets.length} onClick={refresh}><RefreshCw size={17} />{loading === 'refresh' ? 'Обновление…' : 'Обновить составы'}</Button>
      </fieldset>}
      {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
      {connection && <div className="mt-4 border-t border-border pt-3 text-sm">
        <p>Последнее успешное обновление: {connection.lastSuccessAt ? new Date(connection.lastSuccessAt).toLocaleString('ru-RU') : 'ещё не было'}</p>
        {connection.lastError && connection.lastError !== error && !error && <p className="text-danger" role="status">Ошибка обновления: {connection.lastError}</p>}
      </div>}
    </Card>
    <Card>
      <h2 className="card-title">Проверка или локальный импорт CSV</h2>
      <p className="mb-4 mt-1 text-sm text-muted">Укажите названия наборов в строке «Набор», а затем добавьте строки «Страна 1 / локация 1» и остальные лоты. Колонки соответствуют отдельным наборам.</p>
      <div className="form-grid"><Field label="Тип / имя листа"><select className="field-control" value={csvName} onChange={(event) => setCsvName(event.target.value)}><option>×16</option><option>×30</option></select></Field></div>
      <Field label="CSV-данные"><Textarea className="min-h-36 font-mono text-xs" value={csv} onChange={(event) => setCsv(event.target.value)} placeholder={'Набор,Восточная коллекция\nСтрана 1 / локация 1,Эфиопия / Гуджи\nСтрана 2 / локация 2,Колумбия / Уила\nСтрана 3 / локация 3,Бразилия / Серрадо\nСтрана 4 / локация 4,Кения / Ньери'} /></Field>
      <Button className="mt-4" variant="secondary" disabled={!csv.trim() || Boolean(loading)} onClick={importCsv}>{loading === 'csv' ? 'Импорт…' : 'Импортировать CSV'}</Button>
    </Card>
  </div>
}

export default function CompositionsPage() {
  const data = useAppData()
  const { unlocked, requestUnlock } = useAdmin()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'all'
  const setTab = (value: string) => setParams(value === 'all' ? {} : { tab: value }, { replace: true })
  const [manualEdit, setManualEdit] = useState<ManualComposition | 'new'>()
  const selectedId = params.get('composition')
  const setSelectedId = (id?: string) => setParams(id ? { composition: id } : {}, { replace: true })
  const compositions = [...data.importedCompositions, ...data.manualCompositions].sort((left, right) => left.name.localeCompare(right.name, 'ru'))
  const selected = compositions.find((item) => item.id === selectedId)
  const capacity = selected && compositionCapacity(selected.items, data.inventory)
  const connection = currentSheetConnection(data.sheetConnections)
  const csvConnection = data.sheetConnections.find((entry) => entry.url === localCsvName)
  const requireAdmin = (action: () => void) => unlocked ? action() : requestUnlock()
  const createManual = () => requireAdmin(() => setManualEdit('new'))
  const source = (composition: (typeof compositions)[number]) => {
    if (!('sheetConnectionId' in composition)) return 'Ручной'
    if (composition.isDemo) return 'Демо'
    return csvConnection?.id === composition.sheetConnectionId ? 'CSV' : 'Google Sheets'
  }

  return <>
    <PageHeader title="Составы наборов" description="Google Sheets, ручные наборы и сопоставление со стоком" action={<Button onClick={createManual}><Plus size={18} />Ручной состав</Button>} />
    <div className="tabs mb-5">
      <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>Все составы <span>{compositions.length}</span></button>
      <button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>Редактор</button>
      <button className={tab === 'google' ? 'active' : ''} onClick={() => setTab('google')}>Google Sheets</button>
    </div>
    {tab === 'all' && (!compositions.length ? <Empty title="Нет составов" text="Подключите Google Sheets или создайте ручной набор." action={<Button onClick={() => setTab('google')}>Подключить таблицу</Button>} /> :
      <Card className="stock-journal"><table className="stock-table" aria-label="Составы наборов">
        <thead><tr><th scope="col">Набор</th><th scope="col">Формат</th><th scope="col">Источник</th><th scope="col">Состояние</th><th scope="col"><span className="sr-only">Действие</span></th></tr></thead>
        <tbody>{compositions.map((item) => <tr className="inventory-row" key={item.id}>
          <th scope="row">{item.name}</th><td className="stock-date">{formatLabels[item.kind]}</td><td className="stock-destinations">{source(item)}</td>
          <td className="stock-status"><Badge tone={item.enabled ? 'success' : 'neutral'}>{item.enabled ? 'Активен' : 'Отключён'}</Badge></td>
          <td className="stock-action"><Button size="sm" variant="secondary" onClick={() => setSelectedId(item.id)} aria-label={`Открыть состав ${item.name}`}>Открыть</Button></td>
        </tr>)}</tbody>
      </table></Card>)}
    {selected && capacity && !manualEdit && <Modal title={selected.name} onClose={() => setSelectedId(undefined)} wide>
      <div className="grid gap-4">
        <div><p className="text-sm text-muted">{formatLabels[selected.kind]} / {source(selected)}</p><p>Можно собрать <strong>{selected.enabled ? capacity.maximum : '—'} наб.</strong></p></div>
        <section><h3 className="mb-2 font-semibold">Ингредиенты и сток</h3>
          <div className="grid gap-2">{capacity.matches.map((match) => {
            const item = match.item
            const unresolved = match.ambiguous || (!match.matched && !item.inventoryLotId)
            return <div className="composition-item" key={item.id}>
              <div><strong>{item.country} / {item.coffeeName}</strong><p>{item.quantityPerSet} пак. на набор / {match.available} доступно</p>
                {match.ambiguous ? <p className="text-danger">Нужно выбрать лот</p> : unresolved ? <p className="text-danger">Нет сопоставления со стоком</p> : <p className="text-muted">Партий на стоке: {match.lots.length}</p>}
              </div>
              {'sheetConnectionId' in selected && <select aria-label={`Сопоставить ${item.coffeeName}`} className="field-control compact" value={item.inventoryLotId ?? ''} onChange={(event) => {
                const lotId = event.target.value
                if (lotId) requireAdmin(() => void saveAlias(item.country, item.coffeeName, lotId).then(() => toast.success('Сопоставление сохранено')).catch((cause) => toast.error(errorMessage(cause, 'Не удалось сохранить сопоставление'))))
              }}><option value="" disabled>{unresolved ? 'Выбрать лот' : 'По названию'}</option><LotOptions lots={data.lots} /></select>}
            </div>
          })}</div>
        </section>
        <div className="flex flex-wrap gap-2">
          {!('sheetConnectionId' in selected) && <Button variant="secondary" onClick={() => requireAdmin(() => setManualEdit(selected))}>Редактировать</Button>}
          <Button variant="secondary" onClick={() => requireAdmin(() => void toggleComposition(selected.id, 'sheetConnectionId' in selected).catch((cause) => toast.error(errorMessage(cause, 'Не удалось изменить состояние'))))}>{selected.enabled ? 'Отключить' : 'Включить'}</Button>
        </div>
      </div>
    </Modal>}
    {tab === 'manual' && <Card><h2 className="card-title">Ручные форматы</h2><p className="mt-2 max-w-2xl text-muted">×6 — шесть дрипов одного лота. Мега ×6 — шесть пакетов Мега. Подписка — шесть лотов по пять дрипов. Лимита — произвольные позиции и количество.</p><Button className="mt-5" onClick={createManual}>Создать ручной состав</Button></Card>}
    {tab === 'google' && <SheetImporter connection={connection} csvConnection={csvConnection} />}
    {manualEdit && <ManualForm composition={manualEdit === 'new' ? undefined : manualEdit} data={data} onClose={(saved) => { setManualEdit(undefined); if (saved) setTab('all') }} />}
  </>
}
