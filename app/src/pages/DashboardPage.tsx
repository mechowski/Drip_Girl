import { addDays, format, parseISO } from 'date-fns'
import { ru } from 'date-fns/locale'
import { Plus } from 'lucide-react'
import { Link } from 'react-router'
import { useAppData } from '@/hooks/useAppData'
import { formatNumber } from '@/domain/calculations'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Card, Empty, PageHeader } from '@/ui/components'

import { LotCard } from '@/ui/LotCard'
import { ShiftCalendar, type ShiftCalendarEntry } from '@/ui/ShiftCalendar'

type QueueRow = { id: string; name: string; status: string; quantity: string; action: string; to: string; tone: 'accent' | 'warning' | 'neutral' }

export default function DashboardPage() {
  const data = useAppData()
  const { unlocked } = useAdmin()
  const now = new Date()
  const today = format(now, 'yyyy-MM-dd')
  const closed = data.productionDays.some((day) => day.date === today && day.status === 'closed')
  const ready: QueueRow[] = []
  const decisions: QueueRow[] = []
  const upcoming: QueueRow[] = []
  const production = new Map<string, QueueRow[]>()
  const tasks = data.productionTasks.filter((task) => task.status === 'open').sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))

  for (const task of tasks) {
    const formatDef = data.settings.formats.find((item) => item.id === task.formatId)
    const needsPacking = task.scheduleDecision === 'bu' && !task.inBU
    const needsDecision = !task.approved || needsPacking
    if (needsDecision && !unlocked) continue
    const canStart = !needsDecision && task.plannedDate <= today
    const action = !unlocked ? 'Открыть задачу' : needsPacking
      ? task.approved ? 'Запаковать в Б/у' : 'Подтвердить упаковку'
      : needsDecision ? 'Подтвердить дату' : canStart ? 'Внести выпуск' : 'Открыть задачу'
    const row: QueueRow = {
      id: task.id,
      name: [formatDef?.name, task.purpose].filter(Boolean).join(' / ') || 'Изготовление',
      status: !task.approved ? 'Ждёт подтверждения' : needsPacking ? 'Ждёт упаковки' : canStart ? 'Готово к фасовке' : format(parseISO(task.plannedDate), 'd MMMM', { locale: ru }),
      quantity: `${formatNumber(Math.max(0, task.plannedQuantity - task.producedQuantity))} шт.`,
      action,
      to: `/production?task=${encodeURIComponent(task.id)}`,
      tone: needsDecision ? 'warning' : canStart ? 'accent' : 'neutral',
    }
    const lotRows = production.get(task.lotId)
    if (lotRows) lotRows.push(row)
    else production.set(task.lotId, [row])
  }

  for (const task of data.assemblyTasks) {
    if (!['confirmed', 'partial', 'transferred'].includes(task.status)) continue
    const isUpcoming = task.productionDate > today
    const row: QueueRow = {
      id: task.id, name: task.name,
      status: isUpcoming ? format(parseISO(task.productionDate), 'd MMMM', { locale: ru }) : 'Резерв подтверждён',
      quantity: `${formatNumber(task.plannedQuantity - task.completedQuantity)} наб.`,
      action: 'Открыть сборку', to: `/assembly#task-${task.id}`, tone: isUpcoming ? 'neutral' : 'accent',
    }
    if (isUpcoming) upcoming.push(row)
    else ready.push(row)
  }
  for (const plan of unlocked ? data.assemblyPlans : []) {
    if (plan.status === 'draft') decisions.push({
      id: plan.id, name: 'План сборки', status: 'Ожидает резерва', quantity: '',
      action: 'Открыть план', to: `/assembly#plan-${plan.id}`, tone: 'warning',
    })
  }

  const calendarEntries = new Map<string, ShiftCalendarEntry[]>()
  const productionToday: ShiftCalendarEntry[] = []
  const assemblyToday: ShiftCalendarEntry[] = []
  const lotNames = new Map(data.lots.map((lot) => [lot.id, `${lot.country} / ${lot.name}`]))

  function addCalendarEntry(date: string, entry: ShiftCalendarEntry) {
    const entries = calendarEntries.get(date)
    if (entries) entries.push(entry)
    else calendarEntries.set(date, [entry])
  }

  for (const task of data.productionTasks) {
    if (task.status === 'cancelled') continue
    const row = production.get(task.lotId)?.find(({ id }) => id === task.id)
    const formatName = data.settings.formats.find(({ id }) => id === task.formatId)?.name
    const designation = [formatName, task.purpose].filter(Boolean).join(' / ')
    const entry = {
      id: task.id, title: lotNames.get(task.lotId) ?? 'Производственная задача',
      detail: ['Производство', designation, `${formatNumber(task.plannedQuantity)} шт.`].filter(Boolean).join(' · '),
      to: `/production?task=${encodeURIComponent(task.id)}`,
    }
    addCalendarEntry(task.plannedDate, entry)
    if (row && task.plannedDate <= today) {
      productionToday.push({ ...entry, detail: [designation, row.status, row.quantity].filter(Boolean).join(' · ') })
    }
  }

  for (const task of data.assemblyTasks) {
    const draft = task.status === 'draft' || task.status === 'pending'
    if (task.status === 'cancelled' || (draft && !unlocked)) continue
    const entry = {
      id: task.id, title: task.name,
      detail: `Сборка · ${formatNumber(task.plannedQuantity)} наб.${draft ? ' · черновик' : ''}`,
      to: draft ? `/assembly#plan-${task.planId}` : `/assembly#task-${task.id}`,
    }
    addCalendarEntry(task.productionDate, entry)
    if (task.productionDate <= today && ['confirmed', 'partial', 'transferred'].includes(task.status)) {
      assemblyToday.push({ ...entry, detail: `Осталось ${formatNumber(task.plannedQuantity - task.completedQuantity)} наб.` })
    }
  }

  const produced = data.productionEntries.filter((entry) => format(new Date(entry.createdAt), 'yyyy-MM-dd') === today).reduce((sum, entry) => sum + entry.quantity, 0)
  const assembled = data.assemblyReports.filter((report) => report.productionDate === today).reduce((sum, report) => sum + report.quantity, 0)
  const reserved = data.inventory.reduce((sum, lot) => sum + lot.reserved, 0)
  const unread = unlocked ? data.warnings.filter((warning) => !warning.read).length : 0

  return <>
    <PageHeader title="Сегодня" description={format(now, 'EEEE, d MMMM', { locale: ru })} action={unlocked &&
      <Link className="button button-primary" to="/?new=1"><Plus size={17} aria-hidden="true" />Новый лот</Link>
    } />
    <div className="shift-status"><Badge tone={closed ? 'neutral' : 'success'}>{closed ? 'Смена закрыта' : 'Смена открыта'}</Badge></div>
    <div className="shift-overview">
      <ShiftOverview title="Производство дрипов" entries={productionToday} to="/production" link="Открыть производство" />
      <ShiftOverview title="Сборка наборов" entries={assemblyToday} to="/assembly" link="Открыть сборку" />
      <div className="shift-overview-aside">
        <ShiftCalendar now={now} entries={calendarEntries} />
        <Card className="shift-overview-panel shift-summary">
          <h2>Итоги смены</h2>
          <div className={`stats-strip${unlocked ? '' : ' shift-totals-operator'}`}>
            <div><span>Выпущено дрипов</span><strong>{formatNumber(produced)} шт.</strong></div>
            <div><span>Собрано наборов</span><strong>{formatNumber(assembled)} наб.</strong></div>
            <div><span>В резерве</span><strong>{formatNumber(reserved)} шт.</strong></div>
            {unlocked && <div><span>Предупреждения</span><strong>{unread}</strong></div>}
          </div>
        </Card>
      </div>
    </div>
    {production.size > 0 && <section className="shift-production" aria-labelledby="shift-production-title">
      <div className="lot-list-heading"><h2 id="shift-production-title">Лоты в работе</h2><span>{production.size}</span></div>
      <div className="lot-panel-list">{Array.from(production, ([lotId, rows]) => {
        const lot = data.lots.find((item) => item.id === lotId)
        return <LotCard key={lotId} lotId={lot?.id} title={lot ? `${lot.country} / ${lot.name}` : 'Производственная задача'}>
          <ul className="shift-lot-rows">{rows.map((row) => <ShiftQueueRow key={row.id} row={row} />)}</ul>
        </LotCard>
      })}</div>
    </section>}
    <div className="shift-queues">
      <ShiftQueue title="Можно начать" rows={ready} empty="Готовых задач пока нет." />
      {unlocked && <ShiftQueue title="Требует решения" rows={decisions} empty="Ожидающих решений нет." />}
      <ShiftQueue title="Дальше по плану" rows={upcoming} empty="Будущих задач пока нет." />
    </div>
    <Card className="degas-section">
      <div className="dashboard-section-head"><h2>Дегазация на неделе</h2><Link to="/calendar">Календарь</Link></div>
      <div className="degas-grid shift-week">{Array.from({ length: 7 }, (_, index) => {
        const day = addDays(now, index)
        const date = format(day, 'yyyy-MM-dd')
        const lots = data.lots.filter((lot) => tasks.some((task) => task.readyDate === date && task.lotId === lot.id))
        return <div className={`degas-day ${index === 0 ? 'today' : ''}`} key={date}>
          <time dateTime={date}>{format(day, 'EEE dd', { locale: ru })}</time>
          {lots.length ? lots.map((lot) => <div className="degas-lot" key={lot.id}>{lot.name}</div>) : <span className="empty-mini">Нет лотов</span>}
        </div>
      })}</div>
    </Card>
    {!data.lots.length && <Empty title="Пока нет лотов" text="После регистрации лота здесь появится его производственная задача." />}
  </>
}

function ShiftOverview({ title, entries, to, link }: { title: string; entries: ShiftCalendarEntry[]; to: string; link: string }) {
  return <Card className="shift-overview-panel shift-overview-queue">
    <h2>{title}</h2>
    <p className="shift-overview-count"><strong>{formatNumber(entries.length)}</strong><span>Задач к работе</span></p>
    {entries.length > 0 && <ul className="shift-day-plan">
      {entries.slice(0, 3).map((entry) => <li key={entry.id}>
        <Link to={entry.to}>{entry.title}</Link>
        <p>{entry.detail}</p>
      </li>)}
    </ul>}
    <Link className="shift-overview-link" to={to}>{link}</Link>
  </Card>
}

function ShiftQueue({ title, rows, empty }: { title: string; rows: QueueRow[]; empty: string }) {
  return <Card className="shift-queue">
    <h2 className="card-title">{title}</h2>
    {rows.length ? <ul>{rows.map((row) => <ShiftQueueRow key={row.id} row={row} />)}</ul> : <p className="mt-2 text-sm text-muted">{empty}</p>}
  </Card>
}

function ShiftQueueRow({ row }: { row: QueueRow }) {
  return <li className="shift-row">
    <strong>{row.name}</strong>
    <div><Badge tone={row.tone}>{row.status}</Badge></div>
    <span className="shift-number">{row.quantity}</span>
    <Link className={`button button-sm ${row.tone === 'accent' ? 'button-primary' : 'button-secondary'}`} to={row.to}>{row.action}</Link>
  </li>
}
