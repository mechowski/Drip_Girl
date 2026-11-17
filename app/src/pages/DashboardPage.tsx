import { addDays, format, parseISO } from 'date-fns'
import { ru } from 'date-fns/locale'
import { Plus } from 'lucide-react'
import { Link } from 'react-router'
import { useAppData } from '@/hooks/useAppData'
import { formatNumber } from '@/domain/calculations'
import { Badge, Card, Empty, PageHeader } from '@/ui/components'

type QueueRow = { id: string; name: string; status: string; quantity: string; action: string; to: string; tone: 'accent' | 'warning' | 'neutral' }

export default function DashboardPage() {
  const data = useAppData()
  const now = new Date()
  const today = format(now, 'yyyy-MM-dd')
  const closed = data.productionDays.some((day) => day.date === today && day.status === 'closed')
  const ready: QueueRow[] = []
  const decisions: QueueRow[] = []
  const upcoming: QueueRow[] = []
  const tasks = data.productionTasks.filter((task) => task.status === 'open').sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))

  for (const task of tasks) {
    const lot = data.lots.find((item) => item.id === task.lotId)
    const formatDef = data.settings.formats.find((item) => item.id === task.formatId)
    const needsPacking = task.scheduleDecision === 'bu' && !task.inBU
    const needsDecision = !task.approved || needsPacking
    const canStart = !needsDecision && task.plannedDate <= today
    const action = needsPacking ? 'Запаковать в Б/у' : needsDecision ? 'Подтвердить дату' : canStart ? 'Внести выпуск' : 'Открыть задачу'
    const row: QueueRow = {
      id: task.id,
      name: lot ? `${lot.country} / ${lot.name}${formatDef ? ` · ${formatDef.name}` : ''}` : 'Производственная задача',
      status: needsDecision ? 'Ждёт подтверждения' : canStart ? 'Готово к фасовке' : format(parseISO(task.plannedDate), 'd MMMM', { locale: ru }),
      quantity: `${formatNumber(Math.max(0, task.plannedQuantity - task.producedQuantity))} шт.`,
      action,
      to: `/production?task=${encodeURIComponent(task.id)}`,
      tone: needsDecision ? 'warning' : canStart ? 'accent' : 'neutral',
    }
    if (needsDecision) decisions.push(row)
    else if (canStart) ready.push(row)
    else upcoming.push(row)
  }

  for (const task of data.assemblyTasks) {
    if (!['confirmed', 'partial', 'transferred'].includes(task.status)) continue
    ready.push({
      id: task.id, name: task.name, status: 'Резерв подтверждён',
      quantity: `${formatNumber(task.plannedQuantity - task.completedQuantity)} наб.`,
      action: 'Открыть сборку', to: `/assembly#task-${task.id}`, tone: 'accent',
    })
  }
  for (const plan of data.assemblyPlans) {
    if (plan.status === 'draft') decisions.push({
      id: plan.id, name: 'План сборки', status: 'Ожидает резерва', quantity: '',
      action: 'Открыть план', to: `/assembly#plan-${plan.id}`, tone: 'warning',
    })
  }

  const produced = data.productionEntries.filter((entry) => format(new Date(entry.createdAt), 'yyyy-MM-dd') === today).reduce((sum, entry) => sum + entry.quantity, 0)
  const assembled = data.assemblyReports.filter((report) => report.productionDate === today).reduce((sum, report) => sum + report.quantity, 0)
  const reserved = data.inventory.reduce((sum, lot) => sum + lot.reserved, 0)
  const unread = data.warnings.filter((warning) => !warning.read).length

  return <>
    <PageHeader title="Сегодня" description={format(now, 'EEEE, d MMMM', { locale: ru })} action={
      <Link className="button button-primary" to="/?new=1"><Plus size={17} aria-hidden="true" />Новый лот</Link>
    } />
    <div className="shift-status"><Badge tone={closed ? 'neutral' : 'success'}>{closed ? 'Смена закрыта' : 'Смена открыта'}</Badge></div>
    <div className="shift-queues">
      <ShiftQueue title="Можно начать" rows={ready} empty="Готовых задач пока нет." />
      <ShiftQueue title="Требует решения" rows={decisions} empty="Ожидающих решений нет." />
      <ShiftQueue title="Дальше по плану" rows={upcoming} empty="Будущих задач пока нет." />
    </div>
    <section className="mt-6" aria-labelledby="shift-totals">
      <div className="section-title"><h2 id="shift-totals">Итоги смены</h2></div>
      <div className="stats-strip">
        <div><span>Выпущено дрипов</span><strong>{formatNumber(produced)} шт.</strong></div>
        <div><span>Собрано наборов</span><strong>{formatNumber(assembled)} наб.</strong></div>
        <div><span>В резерве</span><strong>{formatNumber(reserved)} шт.</strong></div>
        <div><span>Предупреждения</span><strong>{unread}</strong></div>
      </div>
    </section>
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

function ShiftQueue({ title, rows, empty }: { title: string; rows: QueueRow[]; empty: string }) {
  return <Card className="shift-queue">
    <h2 className="card-title">{title}</h2>
    {rows.length ? <ul>{rows.map((row) => <li className="shift-row" key={row.id}>
      <strong>{row.name}</strong>
      <div><Badge tone={row.tone}>{row.status}</Badge></div>
      <span className="shift-number">{row.quantity}</span>
      <Link className={`button button-sm ${row.tone === 'accent' ? 'button-primary' : 'button-secondary'}`} to={row.to}>{row.action}</Link>
    </li>)}</ul> : <p className="mt-2 text-sm text-muted">{empty}</p>}
  </Card>
}
