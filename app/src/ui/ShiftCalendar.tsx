import { useState } from 'react'
import { addDays, addMonths, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek } from 'date-fns'
import { ru } from 'date-fns/locale'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { Card, Modal } from './components'

export type ShiftCalendarEntry = { id: string; title: string; detail: string; to: string }

const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const weekOptions = { weekStartsOn: 1 } as const

export function ShiftCalendar({ now, entries }: { now: Date; entries: Map<string, ShiftCalendarEntry[]> }) {
  const [month, setMonth] = useState(() => startOfMonth(now))
  const [selected, setSelected] = useState<Date>()
  const monthEnd = endOfMonth(month)
  const last = endOfWeek(monthEnd, weekOptions)
  const today = format(now, 'yyyy-MM-dd')
  const selectedKey = selected ? format(selected, 'yyyy-MM-dd') : undefined
  const plan = selectedKey ? entries.get(selectedKey) ?? [] : []

  const cells = []
  for (let date = startOfWeek(month, weekOptions); date <= last; date = addDays(date, 1)) {
    const key = format(date, 'yyyy-MM-dd')
    const count = entries.get(key)?.length ?? 0
    cells.push(date < month || date > monthEnd
      ? <span key={key} aria-hidden="true" />
      : <button key={key} type="button" className={count ? 'shift-calendar-day has-tasks' : 'shift-calendar-day'} aria-current={key === today ? 'date' : undefined}
          aria-label={`${format(date, 'd MMMM yyyy', { locale: ru })}, задач: ${count}`} onClick={() => setSelected(date)}>
          <time dateTime={key}>{date.getDate()}</time>
          <span className="shift-calendar-count" aria-hidden="true">{count || '–'}</span>
        </button>)
  }

  return <Card className="shift-overview-panel">
    <h2>Календарь</h2>
    <div className="shift-calendar-month">
      <button className="icon-button" type="button" aria-label="Предыдущий месяц" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={18} aria-hidden="true" /></button>
      <strong aria-live="polite">{format(month, 'LLLL yyyy', { locale: ru })}</strong>
      <button className="icon-button" type="button" aria-label="Следующий месяц" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={18} aria-hidden="true" /></button>
    </div>
    <div className="shift-calendar-grid">
      {weekdays.map((day) => <span className="shift-calendar-weekday" key={day}>{day}</span>)}
      {cells}
    </div>
    <Link className="shift-overview-link" to="/calendar">Открыть календарь</Link>
    {selected && <Modal title={`План на ${format(selected, 'd MMMM', { locale: ru })}`} onClose={() => setSelected(undefined)}>
      <div className="shift-day-plan-dialog">
        {plan.length ? <ul className="shift-day-plan">{plan.map((entry) => <li key={entry.id}>
          <Link to={entry.to}>{entry.title}</Link>
          <p>{entry.detail}</p>
        </li>)}</ul> : <p className="text-sm text-muted">На этот день задач нет.</p>}
        <Link className="shift-overview-link" to={`/calendar?date=${selectedKey}`}>Открыть эту неделю в календаре</Link>
      </div>
    </Modal>}
  </Card>
}
