import { useState } from 'react'
import { addDays, addMonths, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek } from 'date-fns'
import { ru } from 'date-fns/locale'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { QuickViewLink } from './QuickViewLink'
import { Button, Card, Modal } from './components'
import type { ShiftCalendarEntry } from './shiftCalendarEntries'

const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const weekOptions = { weekStartsOn: 1 } as const
const eventNames = { production: 'Изготовление', assembly: 'Сборка', degassing: 'Дегазация', packing: 'Упаковка в Б/у' }

export function ShiftCalendar({ now, entries, full = false, initialDay, isWorking }: {
  now: Date
  entries: Map<string, ShiftCalendarEntry[]>
  full?: boolean
  initialDay?: Date
  isWorking?: (date: string) => boolean
}) {
  const [month, setMonth] = useState(() => startOfMonth(initialDay ?? now))
  const [selected, setSelected] = useState<Date | undefined>(initialDay)
  const monthEnd = endOfMonth(month)
  const last = endOfWeek(monthEnd, weekOptions)
  const today = format(now, 'yyyy-MM-dd')
  const selectedKey = selected ? format(selected, 'yyyy-MM-dd') : undefined
  const plan = selectedKey ? entries.get(selectedKey) ?? [] : []
  const groups = new Map<string, ShiftCalendarEntry[]>()
  for (const entry of plan) {
    const items = groups.get(entry.group)
    if (items) items.push(entry)
    else groups.set(entry.group, [entry])
  }

  const cells = []
  for (let date = startOfWeek(month, weekOptions); date <= last; date = addDays(date, 1)) {
    const key = format(date, 'yyyy-MM-dd')
    if (date < month || date > monthEnd) {
      cells.push(<span className="shift-calendar-pad" key={key} aria-hidden="true" />)
      continue
    }
    const dayEntries = entries.get(key) ?? []
    const count = dayEntries.length
    const rest = count - 2
    const classes = ['shift-calendar-day', count ? 'has-tasks' : '', isWorking?.(key) === false ? 'nonworking' : ''].filter(Boolean).join(' ')
    cells.push(<button key={key} type="button" className={classes} aria-current={key === today ? 'date' : undefined}
      aria-label={`${format(date, 'd MMMM yyyy', { locale: ru })}, ${full ? 'событий' : 'задач'}: ${count}`} onClick={() => setSelected(date)}>
      <span className="shift-calendar-day-top">
        <time dateTime={key}>{date.getDate()}</time>
        <span className="shift-calendar-count" aria-hidden="true">{count || '–'}</span>
      </span>
      {full && count > 0 && <span className="calendar-cell-events" aria-hidden="true">
        {dayEntries.slice(0, 2).map((entry, index) => <span className="calendar-cell-event" key={entry.id}>
          {entry.group !== dayEntries[index - 1]?.group && <strong>{entry.title}</strong>}
          <span>{entry.kind === 'production' ? entry.label : eventNames[entry.kind]}{entry.quantity && ` · ${entry.quantity}`}</span>
        </span>)}
        {rest > 0 && <span className="calendar-cell-more">Ещё {rest}</span>}
      </span>}
    </button>)
  }

  return <Card className={full ? 'shift-calendar-full' : 'shift-overview-panel'}>
    {!full && <h2><Link className="shift-panel-link" to="/calendar">Календарь<ChevronRight size={18} aria-hidden="true" /></Link></h2>}
    <div className="shift-calendar-month">
      <button className="icon-button" type="button" aria-label="Предыдущий месяц" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={18} aria-hidden="true" /></button>
      <strong aria-live="polite">{format(month, 'LLLL yyyy', { locale: ru })}</strong>
      <button className="icon-button" type="button" aria-label="Следующий месяц" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={18} aria-hidden="true" /></button>
      {full && <Button size="sm" variant="secondary" onClick={() => setMonth(startOfMonth(now))}>Текущий месяц</Button>}
    </div>
    <div className="shift-calendar-grid">
      {weekdays.map((day) => <span className="shift-calendar-weekday" key={day}>{day}</span>)}
      {cells}
    </div>
    {selected && <Modal title={`План на ${format(selected, 'd MMMM', { locale: ru })}`} onClose={() => setSelected(undefined)}>
      <div className={full ? undefined : 'shift-day-plan-dialog'}>
        {selectedKey && isWorking?.(selectedKey) === false && <p className="text-sm text-muted">Нерабочий день</p>}
        {plan.length ? <>
          <p className="shift-overview-count"><strong>{plan.length}</strong><span>{full ? 'Событий на день' : 'Задач на день'}</span></p>
          {Array.from(groups, ([id, items]) => <section className="shift-preview-lot" key={id}>
            <h3>{items[0].title}</h3>
            <ul>{items.map((entry) => <li className="shift-preview-row" key={entry.id}>
              <div><strong>{entry.label}</strong><p>{entry.detail}</p></div>
              {entry.quantity && <span>{entry.quantity}</span>}
              <QuickViewLink className={`button button-sm ${entry.canProduce ? 'button-primary' : 'button-secondary'}`} to={entry.to}
                aria-label={`${entry.canProduce ? 'Произвести' : 'Открыть'}: ${entry.title} · ${entry.label}`}>
                {entry.canProduce ? 'Произвести' : 'Открыть'}
              </QuickViewLink>
            </li>)}</ul>
          </section>)}
        </> : <p className="text-sm text-muted">На этот день задач нет.</p>}
        {!full && <Link className="shift-overview-link" to={`/calendar?date=${selectedKey}`}>Открыть день в календаре</Link>}
      </div>
    </Modal>}
  </Card>
}
