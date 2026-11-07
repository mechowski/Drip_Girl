import { addDays, format } from 'date-fns'
import { ru } from 'date-fns/locale'
import { AlertTriangle, Bell, CheckCircle2, ClipboardList, Coffee } from 'lucide-react'
import { Link } from 'react-router'
import { useAppData } from '@/hooks/useAppData'
import { formatNumber, remainingCoffee } from '@/domain/calculations'
import { Badge, Card, Empty } from '@/ui/components'

const activeAssembly = ['confirmed', 'partial', 'transferred']

export default function DashboardPage() {
  const data = useAppData()
  const today = format(new Date(), 'yyyy-MM-dd')
  const openTasks = data.productionTasks.filter((task) => task.status === 'open').sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))
  const producedToday = data.productionEntries.filter((entry) => entry.createdAt.startsWith(today)).reduce((sum, entry) => sum + entry.quantity, 0)
  const coffeeInWork = openTasks.reduce((sum, task) => {
    const formatDef = data.settings.formats.find((item) => item.id === task.formatId)
    return sum + (formatDef ? remainingCoffee(task, formatDef) : 0)
  }, 0)
  const reserved = data.inventory.reduce((sum, lot) => sum + lot.reserved, 0)
  const unread = data.warnings.filter((warning) => !warning.read)
  const assemblyTasks = data.assemblyTasks.filter((task) => activeAssembly.includes(task.status))
  const assemblyPlan = assemblyTasks.reduce((sum, task) => sum + task.plannedQuantity, 0)
  const assemblyDone = assemblyTasks.reduce((sum, task) => sum + task.completedQuantity, 0)
  const days = Array.from({ length: 5 }, (_, index) => addDays(new Date(), index))

  return <>
    <div className="dashboard-greeting"><h1>Добрый день, Данил</h1><p>{format(new Date(), 'd MMMM', { locale: ru })} · в работе {openTasks.length} задач производства и {assemblyTasks.length} плана сборки</p></div>
    <div className="stats-strip">
      <div><span>Кофе в работе</span><strong>{formatNumber(Number(coffeeInWork.toFixed(1)))} кг</strong><Coffee size={16} className="mt-2 text-muted" /></div>
      <div><span>Готовых дрипов сегодня</span><strong>{formatNumber(producedToday)} шт.</strong><CheckCircle2 size={16} className="mt-2 text-muted" /></div>
      <div><span>В резерве</span><strong>{formatNumber(reserved)} шт.</strong><ClipboardList size={16} className="mt-2 text-muted" /></div>
      <div><span>Предупреждения</span><strong>{unread.length}</strong><Bell size={16} className="mt-2 text-muted" /></div>
    </div>
    <div className="dashboard-grid">
      <Card>
        <div className="dashboard-section-head"><h2>Производство сегодня</h2><Link to="/production">Все задачи</Link></div>
        {!openTasks.length ? <Empty title="Открытых задач нет" text="Новые задачи появятся после регистрации лота." /> : <div className="dashboard-list">{openTasks.slice(0, 5).map((task) => {
          const lot = data.lots.find((item) => item.id === task.lotId)
          const formatDef = data.settings.formats.find((item) => item.id === task.formatId)
          return <div className="dashboard-row" key={task.id}><div><strong>{lot?.country} / {lot?.name}</strong><p>{formatDef?.name} · выход {formatNumber(task.plannedQuantity)} шт.</p></div><div className="dashboard-quantity">{formatNumber(task.producedQuantity)} / {formatNumber(task.plannedQuantity)}<small>изготовлено</small></div><Badge tone={task.producedQuantity >= task.plannedQuantity ? 'success' : 'accent'}>{task.producedQuantity ? 'В работе' : 'К производству'}</Badge></div>
        })}</div>}
      </Card>
      <div className="dashboard-stack">
        <Card>
          <div className="dashboard-section-head"><h2>Сборка сегодня</h2>{assemblyTasks.length > 0 && <Badge tone="success">Резерв активен</Badge>}</div>
          {!assemblyTasks.length ? <p className="text-sm text-muted">Активных заданий сборки пока нет.</p> : <><strong className="text-sm">{assemblyTasks[0].name}{assemblyTasks.length > 1 ? ` и ещё ${assemblyTasks.length - 1}` : ''}</strong><p className="mt-1 text-xs text-muted">{assemblyTasks.length} задания · план {formatNumber(assemblyPlan)} наборов</p><div className="assembly-total"><span>Собрано</span><strong>{formatNumber(assemblyDone)} / {formatNumber(assemblyPlan)}</strong></div><div className="progress-track mt-0"><div className="progress-value" style={{ width: `${Math.min(100, assemblyDone / Math.max(1, assemblyPlan) * 100)}%` }} /></div></>}
          <Link className="button button-secondary button-sm mt-4" to="/assembly">Открыть сборку</Link>
        </Card>
        <Card>
          <div className="dashboard-section-head"><h2>Предупреждения</h2><span>{unread.length}</span></div>
          {!unread.length ? <p className="text-sm text-muted">Всё спокойно, новых предупреждений нет.</p> : unread.slice(0, 3).map((warning) => <div className="dashboard-warning" key={warning.id}><AlertTriangle size={15} /><div><p>{warning.message}</p><time>{format(new Date(warning.createdAt), 'dd.MM.yyyy HH:mm')}</time></div></div>)}
          <Link className="mt-3 inline-block text-xs font-semibold text-[hsl(var(--primary))]" to="/admin">Открыть админпанель</Link>
        </Card>
      </div>
    </div>
    <Card className="degas-section">
      <div className="dashboard-section-head"><h2>Дегазация на неделе</h2><span>Производственный календарь</span></div>
      <div className="degas-grid">{days.map((day, index) => {
        const date = format(day, 'yyyy-MM-dd')
        const tasks = data.productionTasks.filter((task) => task.readyDate === date)
        return <div className={`degas-day ${index === 0 ? 'today' : ''}`} key={date}><time>{format(day, 'EEE dd', { locale: ru })}</time>{!tasks.length ? <span className="empty-mini">Нет лотов</span> : tasks.map((task) => { const lot = data.lots.find((item) => item.id === task.lotId); return <div className="degas-lot" key={task.id}>{lot?.name ?? 'Лот'}</div> })}</div>
      })}</div>
    </Card>
  </>
}
