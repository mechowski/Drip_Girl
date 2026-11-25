import { MoySkladEntry } from '@/ui/MoySkladEntry'
import { productionEntryForBatch } from '@/persistence/productionCorrection'
import { refreshMoySklad } from '@/persistence/moySklad'
import { LotHistory } from '@/ui/LotHistory'
import { useMemo, useState, type FormEvent } from 'react'
import { format } from 'date-fns'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { useAppData } from '@/hooks/useAppData'
import { adjustInventory, reassignInventory } from '@/persistence/repository'
import { available, compareStockFifo, formatNumber, isPrivateLabel, normalizeCoffeeName, purposesForFormat } from '@/domain/calculations'
import { expectedOutput } from '@/domain/expectedOutput'
import { QuickViewLink } from '@/ui/QuickViewLink'
import type { InventoryLot } from '@/domain/types'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Textarea } from '@/ui/components'

import { LotCard } from '@/ui/LotCard'

const editLabels = { adjust: 'Ручная корректировка', writeoff: 'Списание продукции', reassign: 'Переназначение продукции' }
const coffeeLabel = (lot: InventoryLot) => `${lot.country} / ${lot.coffeeName}`
const stockKey = (lot: InventoryLot) => JSON.stringify([lot.sourceLotId, lot.formatId, isPrivateLabel(lot.purpose)])
const poolLabel = (lot: InventoryLot) => isPrivateLabel(lot.purpose) ? 'СТМ' : 'Общая тара'
const stockTotal = (lots: InventoryLot[]) => lots.reduce((sum, lot) => sum + lot.quantity, 0)
const reservedTotal = (lots: InventoryLot[]) => lots.reduce((sum, lot) => sum + lot.reserved, 0)
const dateLabel = (value: string) => format(new Date(value), 'dd.MM.yyyy HH:mm')
const alphabetical = (a: string, b: string) => a.localeCompare(b, 'ru')

function groupLots<T>(lots: T[], groupKey: (lot: T) => string) {
  const groups = new Map<string, T[]>()
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
  const { unlocked } = useAdmin()
  const [params] = useSearchParams()
  const taskId = params.get('task')
  const [query, setQuery] = useState('')
  const [country, setCountry] = useState('')
  const [formatId, setFormatId] = useState('')
  const [purpose, setPurpose] = useState('')
  const [reservedOnly, setReservedOnly] = useState(false)
  const [buOnly, setBuOnly] = useState(false)
  const [sort, setSort] = useState('name')
  const [selectedId, setSelectedId] = useState<string>()
  const [operation, setOperation] = useState<keyof typeof editLabels>()
  const [baseQuantity, setBaseQuantity] = useState(0)
  const [newQuantity, setNewQuantity] = useState(0)
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')
  const [newPurpose, setNewPurpose] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  async function refreshStock() {
    setRefreshing(true)
    setRefreshError('')
    try {
      await refreshMoySklad(true)
      toast.success('Остатки обновлены')
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : 'Не удалось обновить остатки')
    } finally { setRefreshing(false) }
  }
  const selected = data.inventory.find((lot) => lot.id === selectedId)
  const entry = selected && productionEntryForBatch(selected, data.productionEntries)
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
  const groupsBySource = groupLots(groups, ({ lots: [lot] }) => lot.sourceLotId)
  if (sort === 'quantity') {
    const sourceTotal = (sourceGroups: typeof groups) => sourceGroups.reduce((total, { lots }) => total + stockTotal(lots), 0)
    groupsBySource.sort(([, a], [, b]) => sourceTotal(b) - sourceTotal(a))
  }
  const countries = [...new Set(data.inventory.map(({ country: value }) => value))].sort(alphabetical)
  const purposes = [...new Set([...data.settings.purposes, ...data.inventory.map((lot) => lot.purpose)])]
  const formatName = (value: string) => data.settings.formats.find(({ id }) => id === value)?.name ?? value
  const total = stockTotal(filtered)
  const totalReserved = reservedTotal(filtered)
  const today = format(new Date(), 'yyyy-MM-dd')
  const forecast = expectedOutput(data, today).filter((row) => !taskId || row.productionTaskId === taskId)
  const todayTasks = new Set(data.productionTasks.filter((task) => task.plannedDate === today && (!taskId || task.id === taskId)).map(({ id }) => id))
  const expectedReserved = data.expectedReservations.filter((row) => todayTasks.has(row.productionTaskId))
    .reduce((sum, row) => sum + row.quantity, 0)
  const reassignmentPurposes = selected && !isPrivateLabel(selected.purpose) ? purposesForFormat(selected.formatId, data.settings.purposes).filter((value) => value !== selected.purpose) : []

  function openEdit(kind: NonNullable<typeof operation>) {
    if (!selected) return
    if (!unlocked) return
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
    <PageHeader title="Сток" description="Физические остатки, активные резервы и история партий"
      action={unlocked && <Button variant="secondary" disabled={refreshing} onClick={() => void refreshStock()}>{refreshing ? 'Обновляем…' : 'Обновить сток'}</Button>} />
    {(unlocked || data.settings.moySkladSyncedAt) && <p className="mb-3 text-sm text-muted">
      {data.settings.moySkladSyncedAt ? `Последнее обновление МоегоСклада ${dateLabel(data.settings.moySkladSyncedAt)}` : 'Остатки из МоегоСклада ещё не загружены.'}
    </p>}
    {refreshError && <p className="notice mb-3" role="alert">{refreshError}</p>}
    {taskId && <div className="notice release-result mb-5"><p>Партии выбранной производственной задачи</p><Link className="button button-secondary button-sm" to="/inventory">Весь сток</Link></div>}
    <div className="stats-strip"><div><span>Доступно</span><strong>{formatNumber(total - totalReserved)} шт.</strong></div><div><span>Физический остаток</span><strong>{formatNumber(total)} шт.</strong></div><div><span>В резерве</span><strong>{formatNumber(totalReserved)} шт.</strong></div><div><span>Показано партий</span><strong>{filtered.length}</strong></div></div>
    {(forecast.length > 0 || expectedReserved > 0) && <Card className="mb-5">
      <details>
        <summary className="cursor-pointer font-semibold">Ожидаемый выпуск на сегодня</summary>
        <p className="my-2 text-sm text-muted">Свободно по плану {formatNumber(stockTotal(forecast))} шт. · Уже обещано {formatNumber(expectedReserved)} шт.</p>
        {forecast.length > 0 && <ul className="grid gap-2 text-sm">{forecast.map((row) => <li key={row.id} className="detail-line">
          <QuickViewLink className="underline" to={`/production?task=${encodeURIComponent(row.productionTaskId)}`}>
            {coffeeLabel(row)} · {row.purpose}
          </QuickViewLink>
          <strong>{formatNumber(row.quantity)} шт.</strong>
        </li>)}</ul>}
      </details>
    </Card>}
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
      <section className="lot-panel-list" aria-label="Партии на стоке">
        {groupsBySource.map(([sourceId, sourceGroups]) => <LotCard key={sourceId} lotId={data.lots.some((lot) => lot.id === sourceId) ? sourceId : undefined}
          title={coffeeLabel(sourceGroups[0].lots[0])}>
          {sourceGroups.map(({ id, lots }) => {
            const lot = lots[0]
            const label = poolLabel(lot)
            const quantity = stockTotal(lots)
            const reserved = reservedTotal(lots)
            return <div className="stock-pool" key={id}>
              <div className="stock-pool-main">
                <div className="stock-pool-title">
                  <h4>{label}</h4>
                  <p>{formatName(lot.formatId)}{lots.some((item) => item.inBU) && ' · В Б/у'}</p>
                </div>
                <dl className="stock-pool-numbers">
                  <div><dt>Доступно</dt><dd>{formatNumber(quantity - reserved)} шт.</dd></div>
                  <div><dt>Физический остаток</dt><dd>{formatNumber(quantity)} шт.</dd></div>
                  <div><dt>В резерве</dt><dd>{formatNumber(reserved)} шт.</dd></div>
                </dl>
                {lots.length === 1 && <Button size="sm" variant="secondary" onClick={() => setSelectedId(lot.id)} aria-label={`История партии ${coffeeLabel(lot)}${sourceGroups.length > 1 ? ` · ${label} · ${formatName(lot.formatId)}` : ''}`}>История</Button>}
              </div>
              {lots.length > 1 && <details className="stock-pool-details">
                <summary>Партии ({lots.length})</summary>
                <ul>{lots.map((batch) => <li key={batch.id} className="detail-line">
                  <div><strong>{batch.purpose}</strong> · <time dateTime={batch.manufacturedAt}>{dateLabel(batch.manufacturedAt)}</time>
                    <p>{formatNumber(available(batch))} доступно · {formatNumber(batch.reserved)} в резерве</p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => setSelectedId(batch.id)}>История</Button>
                </li>)}</ul>
              </details>}
            </div>
          })}
        </LotCard>)}
      </section>}
    {selected && !operation && <Modal title={coffeeLabel(selected)} onClose={() => setSelectedId(undefined)} wide>
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-2"><Badge tone="accent">{formatName(selected.formatId)}</Badge><Badge>{selected.purpose}</Badge>{selected.inBU && <Badge tone="warning">Находится в Б/у</Badge>}<time className="text-sm text-muted" dateTime={selected.manufacturedAt}>{dateLabel(selected.manufacturedAt)}</time></div>
        <div className="stats-strip three"><div><span>Доступно</span><strong>{formatNumber(available(selected))}</strong></div><div><span>Физический остаток</span><strong>{formatNumber(selected.quantity)}</strong></div><div><span>В резерве</span><strong>{formatNumber(selected.reserved)}</strong></div></div>
        {unlocked && <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => openEdit('adjust')}>Скорректировать</Button><Button variant="secondary" disabled={!available(selected)} onClick={() => openEdit('writeoff')}>Списать</Button><Button variant="secondary" disabled={Boolean(selected.moySkladKey) || !available(selected) || !reassignmentPurposes.length} onClick={() => openEdit('reassign')}>Переназначить</Button></div>}
        {entry && <MoySkladEntry key={entry.id} entry={entry} />}
        <LotHistory lotId={selected.sourceLotId} data={data} />
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
