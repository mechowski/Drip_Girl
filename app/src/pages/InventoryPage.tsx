import { useMemo, useState, type FormEvent } from 'react'
import { format } from 'date-fns'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { useAppData } from '@/hooks/useAppData'
import { adjustInventory, reassignInventory } from '@/persistence/repository'
import { available, compareStockFifo, exactCoffeeKey, formatNumber, normalizeCoffeeName, purposesForFormat } from '@/domain/calculations'
import type { InventoryLot } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

const historyLabels = { receipt: 'Приход', reserve: 'Резерв', release: 'Снятие резерва', consume: 'Списание', adjust: 'Корректировка', writeoff: 'Списание', reassign: 'Переназначение' }
const editLabels = { adjust: 'Ручная корректировка', writeoff: 'Списание продукции', reassign: 'Переназначение продукции' }
const coffeeLabel = (lot: InventoryLot) => `${lot.country} / ${lot.coffeeName}`
const stockKey = (lot: InventoryLot) => exactCoffeeKey(lot.country, lot.coffeeName)
const stockTotal = (lots: InventoryLot[]) => lots.reduce((sum, lot) => sum + lot.quantity, 0)
const reservedTotal = (lots: InventoryLot[]) => lots.reduce((sum, lot) => sum + lot.reserved, 0)
const dateLabel = (value: string) => format(new Date(value), 'dd.MM.yyyy HH:mm')
const alphabetical = (a: string, b: string) => a.localeCompare(b, 'ru')

function groupLots(lots: InventoryLot[], groupKey: (lot: InventoryLot) => string) {
  const groups = new Map<string, InventoryLot[]>()
  for (const lot of lots) {
    const key = groupKey(lot)
    const existing = groups.get(key)
    if (existing) existing.push(lot)
    else groups.set(key, [lot])
  }
  return [...groups.entries()]
}

export default function InventoryPage() {
  const data = useAppData()
  const { unlocked, requestUnlock } = useAdmin()
  const [params] = useSearchParams()
  const taskId = params.get('task')
  const [query, setQuery] = useState('')
  const [country, setCountry] = useState('')
  const [formatId, setFormatId] = useState('')
  const [purpose, setPurpose] = useState('')
  const [reservedOnly, setReservedOnly] = useState(false)
  const [buOnly, setBuOnly] = useState(false)
  const [sort, setSort] = useState('name')
  const [groupId, setGroupId] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [operation, setOperation] = useState<keyof typeof editLabels>()
  const [baseQuantity, setBaseQuantity] = useState(0)
  const [newQuantity, setNewQuantity] = useState(0)
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')
  const [newPurpose, setNewPurpose] = useState('')
  const [busy, setBusy] = useState(false)
  const selected = data.inventory.find((lot) => lot.id === selectedId)
  const filtered = useMemo(() => data.inventory.filter((lot) =>
    (!taskId || lot.productionTaskId === taskId) &&
    (!query || normalizeCoffeeName(coffeeLabel(lot)).includes(normalizeCoffeeName(query))) &&
    (!country || lot.country === country) && (!formatId || lot.formatId === formatId) && (!purpose || lot.purpose === purpose) &&
    (!reservedOnly || lot.reserved > 0) && (!buOnly || lot.inBU)), [data.inventory, taskId, query, country, formatId, purpose, reservedOnly, buOnly])
  const groups = useMemo(() => {
    return groupLots(filtered, stockKey).map(([id, lots]) => ({ id, lots: lots.sort((a, b) =>
      (sort === 'quantity' ? b.quantity - a.quantity : 0) || alphabetical(a.formatId, b.formatId) || alphabetical(a.purpose, b.purpose) || compareStockFifo(a, b)) }))
      .sort((a, b) => (sort === 'quantity' ? stockTotal(b.lots) - stockTotal(a.lots) : 0)
        || (sort === 'country' ? alphabetical(a.lots[0].country, b.lots[0].country) : 0)
        || alphabetical(a.lots[0].coffeeName, b.lots[0].coffeeName) || alphabetical(a.lots[0].country, b.lots[0].country))
  }, [filtered, sort])
  const displayedGroup = groups.find(({ id }) => id === groupId)
  const countries = [...new Set(data.inventory.map(({ country: value }) => value))].sort(alphabetical)
  const purposes = [...new Set([...data.settings.purposes, ...data.inventory.map((lot) => lot.purpose)])]
  const formatName = (value: string) => data.settings.formats.find(({ id }) => id === value)?.name ?? value
  const total = stockTotal(filtered)
  const totalReserved = reservedTotal(filtered)
  const selectedTransactions = selected ? data.inventoryTransactions.filter((item) => item.inventoryLotId === selected.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)) : []
  const reassignmentPurposes = selected ? purposesForFormat(selected.formatId, data.settings.purposes).filter((value) => value !== selected.purpose) : []

  function openEdit(kind: NonNullable<typeof operation>) {
    if (!selected) return
    if (!unlocked) { requestUnlock(); return }
    setBaseQuantity(selected.quantity)
    setNewQuantity(kind === 'adjust' ? selected.quantity : available(selected))
    setNewPurpose(reassignmentPurposes[0] ?? '')
    setReason('')
    setComment('')
    setOperation(kind)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!selected || !unlocked || !operation || busy) return
    setBusy(true)
    try {
      if (operation === 'reassign') {
        await reassignInventory(selected.id, newPurpose, newQuantity)
        toast.success('Назначение изменено')
      } else {
        await adjustInventory(selected.id, operation === 'writeoff' ? baseQuantity - newQuantity : newQuantity, reason, comment, baseQuantity, operation)
        toast.success(operation === 'writeoff' ? 'Продукция списана' : 'Остаток скорректирован')
      }
      setOperation(undefined)
      setSelectedId(undefined)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка операции')
    } finally { setBusy(false) }
  }

  return <>
    <PageHeader title="Сток" description="Физические остатки, активные резервы и история партий" />
    {taskId && <div className="notice release-result mb-5"><p>Партии выбранной производственной задачи</p><Link className="button button-secondary button-sm" to="/inventory">Весь сток</Link></div>}
    <div className="stats-strip"><div><span>Доступно</span><strong>{formatNumber(total - totalReserved)} шт.</strong></div><div><span>Физический остаток</span><strong>{formatNumber(total)} шт.</strong></div><div><span>В резерве</span><strong>{formatNumber(totalReserved)} шт.</strong></div><div><span>Показано партий</span><strong>{filtered.length}</strong></div></div>
    <Card className="mb-5"><div className="filters stock-filters">
      <Input aria-label="Поиск по стоку" placeholder="Страна или кофе" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select className="field-control" aria-label="Страна" value={country} onChange={(event) => setCountry(event.target.value)}><option value="">Все страны</option>{countries.map((item) => <option key={item}>{item}</option>)}</select>
      <select className="field-control" aria-label="Формат" value={formatId} onChange={(event) => setFormatId(event.target.value)}><option value="">Все форматы</option>{data.settings.formats.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className="field-control" aria-label="Назначение" value={purpose} onChange={(event) => setPurpose(event.target.value)}><option value="">Все назначения</option>{purposes.map((item) => <option key={item}>{item}</option>)}</select>
      <select className="field-control" aria-label="Сортировка партий" value={sort} onChange={(event) => setSort(event.target.value)}><option value="name">По алфавиту</option><option value="quantity">По количеству</option><option value="country">По стране</option></select>
      <label className="check-filter"><input type="checkbox" checked={reservedOnly} onChange={(event) => setReservedOnly(event.target.checked)} />С резервом</label>
      <label className="check-filter"><input type="checkbox" checked={buOnly} onChange={(event) => setBuOnly(event.target.checked)} />Б/у</label>
    </div></Card>
    {!filtered.length ? <Empty title={data.inventory.length ? 'Партии не найдены' : 'На стоке пусто'} text={data.inventory.length ? 'Измените фильтры, чтобы увидеть другие партии.' : 'Здесь появится продукция после первого выпуска.'} /> :
      <Card className="stock-journal">
        <table className="stock-table" aria-label="Партии на стоке">
          <thead><tr><th scope="col">Партия</th><th scope="col">Дата выпуска</th><th scope="col">Доступно</th><th scope="col">Физический остаток</th><th scope="col">В резерве</th><th scope="col"><span className="sr-only">Действие</span></th></tr></thead>
          {groups.map(({ id, lots }) => <tbody key={id}>
            {lots.length > 1 && <tr className="stock-group"><th scope="rowgroup" colSpan={6}><Button variant="ghost" size="sm" aria-label={`Показать партии ${coffeeLabel(lots[0])}`} onClick={() => setGroupId(id)}>{coffeeLabel(lots[0])} · {lots.length} партий</Button></th></tr>}
            {lots.map((lot) => <tr className="inventory-row" key={lot.id} onClick={() => setSelectedId(lot.id)}>
              <th scope="row"><strong>{coffeeLabel(lot)}</strong><span className="block text-sm text-muted">{formatName(lot.formatId)} / {lot.purpose}</span></th>
              <td className="stock-date"><time dateTime={lot.manufacturedAt}>{dateLabel(lot.manufacturedAt)}</time>{lot.inBU && <Badge tone="warning">В Б/у</Badge>}</td>
              <td className="stock-number"><span>Доступно</span><strong>{formatNumber(available(lot))}</strong></td>
              <td className="stock-number"><span>Физический остаток</span>{formatNumber(lot.quantity)}</td>
              <td className="stock-number"><span>В резерве</span>{formatNumber(lot.reserved)}</td>
              <td className="stock-action"><Button size="sm" variant="secondary" onClick={(event) => { event.stopPropagation(); setSelectedId(lot.id) }} aria-label={`История партии ${coffeeLabel(lot)}`}>История</Button></td>
            </tr>)}
          </tbody>)}
        </table>
      </Card>}
    {displayedGroup && !selected && <Modal title={`${coffeeLabel(displayedGroup.lots[0])} · партии`} onClose={() => setGroupId(undefined)} wide>
      <div className="stats-strip three"><div><span>Доступно</span><strong>{formatNumber(stockTotal(displayedGroup.lots) - reservedTotal(displayedGroup.lots))}</strong></div><div><span>Физический остаток</span><strong>{formatNumber(stockTotal(displayedGroup.lots))}</strong></div><div><span>В резерве</span><strong>{formatNumber(reservedTotal(displayedGroup.lots))}</strong></div></div>
      <div className="grid gap-4">{groupLots(displayedGroup.lots, ({ formatId }) => formatId).map(([formatId, lots]) =>
        <section key={formatId}>
          <h3 className="mb-2 font-semibold">{formatName(formatId)}</h3>
          {groupLots(lots, ({ purpose }) => purpose).map(([purpose, stock]) => <div key={purpose} className="mb-3">
            <Badge>{purpose}</Badge>
            <ul className="grid gap-2">{stock.map((lot) => <li key={lot.id} className="detail-line"><div><time dateTime={lot.manufacturedAt}>{dateLabel(lot.manufacturedAt)}</time><p className="text-sm text-muted">{formatNumber(available(lot))} доступно · {formatNumber(lot.reserved)} в резерве</p></div><Button size="sm" variant="secondary" onClick={() => setSelectedId(lot.id)}>История</Button></li>)}</ul>
          </div>)}
        </section>
      )}</div>
    </Modal>}
    {selected && !operation && <Modal title={coffeeLabel(selected)} onClose={() => setSelectedId(undefined)} wide>
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-2"><Badge tone="accent">{formatName(selected.formatId)}</Badge><Badge>{selected.purpose}</Badge>{selected.inBU && <Badge tone="warning">Находится в Б/у</Badge>}<time className="text-sm text-muted" dateTime={selected.manufacturedAt}>{dateLabel(selected.manufacturedAt)}</time></div>
        <div className="stats-strip three"><div><span>Доступно</span><strong>{formatNumber(available(selected))}</strong></div><div><span>Физический остаток</span><strong>{formatNumber(selected.quantity)}</strong></div><div><span>В резерве</span><strong>{formatNumber(selected.reserved)}</strong></div></div>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => openEdit('adjust')}>Скорректировать</Button><Button variant="secondary" disabled={!available(selected)} onClick={() => openEdit('writeoff')}>Списать</Button><Button variant="secondary" disabled={!available(selected) || !reassignmentPurposes.length} onClick={() => openEdit('reassign')}>Переназначить</Button></div>
        <div><h3 className="mb-3 font-semibold">История операций</h3>{!selectedTransactions.length && <p className="text-sm text-muted">Операций по партии пока нет.</p>}
          {selectedTransactions.map((transaction) => <div className="history-line" key={transaction.id}>
            <div><strong>{historyLabels[transaction.type]}</strong><p>{transaction.author}{transaction.reason && ` · ${transaction.reason}`}</p>{transaction.comment && <p>{transaction.comment}</p>}</div>
            <div><strong>{transaction.quantity > 0 ? '+' : ''}{formatNumber(transaction.quantity)}</strong><time dateTime={transaction.createdAt}>{dateLabel(transaction.createdAt)}</time></div>
          </div>)}
        </div>
      </div>
    </Modal>}
    {selected && operation && unlocked && <Modal title={editLabels[operation]} onClose={() => { if (!busy) setOperation(undefined) }}>
      <form className="grid gap-4" onSubmit={save}>
        {operation === 'reassign' ? <>
          <p className="notice">Доступные пакеты перейдут в другое назначение. Активный резерв сохранится.</p>
          <Field label="Новое назначение"><select className="field-control" value={newPurpose} onChange={(event) => setNewPurpose(event.target.value)} required><option value="">Выберите назначение</option>{reassignmentPurposes.map((item) => <option key={item}>{item}</option>)}</select></Field>
        </> : <>
          {operation === 'writeoff' && <p className="notice">Списанные пакеты вычитаются из физического остатка.</p>}
          <Field label="Причина"><Input required value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
          <Field label="Комментарий"><Textarea value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
        </>}
        <Field label={operation === 'adjust' ? `Новый остаток (было ${baseQuantity})` : `Количество (доступно ${available(selected)})`}><Input type="number" min={operation === 'adjust' ? selected.reserved : 1} max={operation === 'adjust' ? undefined : available(selected)} step="1" value={newQuantity} onChange={(event) => setNewQuantity(Number(event.target.value))} required /></Field>
        <Button variant={operation === 'writeoff' ? 'danger' : 'primary'} disabled={busy}>{operation === 'reassign' ? 'Подтвердить переназначение' : operation === 'writeoff' ? 'Подтвердить списание' : 'Сохранить корректировку'}</Button>
      </form>
    </Modal>}
  </>
}
