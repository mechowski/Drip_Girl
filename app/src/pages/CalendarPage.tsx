import { useState, type FormEvent } from 'react'
import { addDays, format, parseISO, startOfWeek } from 'date-fns'
import { ru } from 'date-fns/locale'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { dayKey, isWorkingDay, parseCalendarSource } from '@/domain/calendar'
import { DEFAULT_CALENDAR_SOURCE, type ProductionTask } from '@/domain/types'
import { useAppData } from '@/hooks/useAppData'
import { approveSchedule, markBU, updateProductionCalendar } from '@/persistence/repository'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader } from '@/ui/components'

const startOfWorkWeek = (date: Date) => startOfWeek(date, { weekStartsOn: 1 })
const displayDate = (date: string) => format(parseISO(date), 'dd.MM.yyyy')

export default function CalendarPage() {
  const data = useAppData()
  const { unlocked } = useAdmin()
  const [edit, setEdit] = useState(false)
  const [day, setDay] = useState('')
  const [mode, setMode] = useState<'working' | 'closed' | 'default'>('closed')
  const [busy, setBusy] = useState(false)
  const [week, setWeek] = useState(() => startOfWorkWeek(new Date()))
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index))
  const tasks = data.productionTasks.filter((task) => task.status !== 'cancelled')
  const source = data.settings.calendarSource ?? DEFAULT_CALENDAR_SOURCE
  const sourceYears = [...new Set([...source.nonWorkingDays, ...source.workingDays].map((value) => value.slice(0, 4)))].sort()
  const overrides = [...new Set([...data.settings.workingOverrides, ...data.settings.nonWorkingDays])].sort()

  const run = async (action: () => Promise<void>, success: string) => {
    if (!unlocked || busy) return false
    setBusy(true)
    try {
      await action()
      toast.success(success)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось обновить календарь')
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveDay = async (event: FormEvent) => {
    event.preventDefault()
    const updated = await run(() => updateProductionCalendar({ day, mode }), 'Производственный календарь обновлён')
    if (updated) {
      setWeek(startOfWorkWeek(parseISO(day)))
      setDay('')
    }
  }

  const importCalendar = (file: File) => run(async () => {
    const calendar = parseCalendarSource(JSON.parse(await file.text()))
    await updateProductionCalendar(calendar)
  }, 'Источник производственного календаря обновлён')

  const confirm = (task: ProductionTask) => {
    const packing = task.scheduleDecision === 'bu'
    void run(() => approveSchedule(task.id), packing ? 'Упаковка в Б/у согласована' : 'Перенос подтверждён')
  }

  const pack = (task: ProductionTask) => {
    void run(() => markBU(task.id), 'Отмечено: находится в Б/у')
  }

  const findLot = (task: ProductionTask) => {
    const lot = data.lots.find((item) => item.id === task.lotId)
    return lot ? `${lot.country} / ${lot.name}` : 'Лот'
  }

  return <>
    <PageHeader title="Календарь" description="Дегазация, упаковка в Б/у и даты изготовления" action={unlocked && <Button variant="secondary" onClick={() => setEdit(true)}>Настроить дни</Button>} />
    <div className="release-result mb-4">
      <Button size="sm" variant="secondary" onClick={() => setWeek(addDays(week, -7))}>Предыдущая неделя</Button>
      <strong>{format(week, 'd MMMM', { locale: ru })} — {format(days[6], 'd MMMM yyyy', { locale: ru })}</strong>
      <Button size="sm" variant="secondary" onClick={() => setWeek(addDays(week, 7))}>Следующая неделя</Button>
    </div>
    <div className="calendar-week">{days.map((value) => {
      const date = dayKey(value)
      const ready = new Map(tasks.filter((task) => task.readyDate === date).map((task) => [task.lotId, task]))
      const manufacturing = tasks.filter((task) => task.plannedDate === date)
      const packing = tasks.filter((task) => task.buDate === date)
      const working = isWorkingDay(date, data.settings)
      return <Card key={date}>
        <div className="calendar-date flex-wrap gap-1">
          <time dateTime={date}>{format(value, 'EEE d', { locale: ru })}</time>
          {!working && <Badge>Нерабочий</Badge>}
        </div>
        <p className="text-sm text-muted">Готовых лотов: <strong>{ready.size}</strong></p>
        {[...ready.values()].filter((task) => task.plannedDate !== date).map((task) => <div className="calendar-week-task" key={task.id}>
          <Link to={`/production?task=${task.id}`} className="font-semibold">{findLot(task)}</Link>
          <p className="mt-1 text-sm text-muted">Дата готовности · изготовление {displayDate(task.plannedDate)}</p>
        </div>)}
        {packing.map((task) => <div className="calendar-week-task" key={task.id}>
          <Link to={`/production?task=${task.id}`} className="font-semibold">{findLot(task)}</Link>
          <p className="mt-1 text-sm text-muted">{task.inBU || !unlocked ? 'Упаковка в Б/у' : `Запаковать в Б/у. Без упаковки дегазация составит ${task.actualDegassingDays} календ. дн.`}</p>
          {task.inBU && <Badge tone="warning">Находится в Б/у</Badge>}
          {unlocked && task.status === 'open' && !task.inBU && (task.approved
            ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => pack(task)}>Запаковать в Б/у</Button>
            : <Button size="sm" variant="secondary" disabled={busy} onClick={() => confirm(task)}>Подтвердить упаковку</Button>)}
        </div>)}
        {manufacturing.map((task) => <div className="calendar-week-task" key={task.id}>
          <Link to={`/production?task=${task.id}`} className="font-semibold">{findLot(task)}</Link>
          <p className="mt-1 text-sm text-muted">Изготовление · {[data.settings.formats.find(({ id }) => id === task.formatId)?.name, task.purpose].filter(Boolean).join(' / ')}</p>
          {task.scheduleDecision === 'move' && <p className="text-xs text-muted">Перенос с {displayDate(task.readyDate)} на {displayDate(task.plannedDate)}</p>}
          {task.scheduleDecision === 'bu' && task.buDate && <p className="text-xs text-muted">Упаковка в Б/у · {displayDate(task.buDate)}</p>}
          {unlocked && task.status === 'open' && task.scheduleDecision === 'move' && !task.approved && <Button size="sm" variant="secondary" disabled={busy} onClick={() => confirm(task)}>Подтвердить перенос</Button>}
        </div>)}
      </Card>
    })}</div>
    {!data.productionTasks.length && <div className="mt-4"><Empty title="Календарь пуст" text="Даты появятся после регистрации лота." /></div>}
    {unlocked && edit && <Modal title="Нерабочие и рабочие дни" onClose={() => { if (!busy) setEdit(false) }}>
      <div className="grid gap-5">
        <form className="grid gap-4" onSubmit={saveDay}>
          <Field label="Дата"><Input type="date" required value={day} onChange={(event) => setDay(event.target.value)} /></Field>
          <Field label="Исключение для даты"><select className="field-control" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            <option value="closed">Нерабочий день</option>
            <option value="working">Рабочий день</option>
            <option value="default">По производственному календарю</option>
          </select></Field>
          <Button disabled={busy}>Сохранить день</Button>
        </form>
        {overrides.length > 0 && <div>
          <h3 className="mb-2 font-semibold">Ручные исключения</h3>
          <ul className="grid gap-2">{overrides.map((value) => <li className="detail-line" key={value}>
            <span>{displayDate(value)} · {data.settings.workingOverrides.includes(value) ? 'рабочий' : 'нерабочий'}</span>
            <Button size="sm" variant="ghost" disabled={busy} aria-label={`Сбросить исключение ${displayDate(value)}`} onClick={() => void run(() => updateProductionCalendar({ day: value, mode: 'default' }), 'Исключение удалено')}>Сбросить</Button>
          </li>)}</ul>
        </div>}
        <div>
          <h3 className="mb-2 font-semibold">Производственный календарь РФ</h3>
          <p className="text-sm text-muted">{sourceYears.length ? `Загружены исключения на ${sourceYears.join(', ')} г.` : 'По умолчанию рабочие дни с понедельника по пятницу.'} Ручные исключения имеют приоритет.</p>
          <p className="my-2 text-sm text-muted">Чтобы заменить источник, загрузите JSON с двумя массивами дат в формате ГГГГ-ММ-ДД: <code>nonWorkingDays</code> и <code>workingDays</code>.</p>
          <Field label="Файл календаря JSON"><Input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) void importCalendar(file)
          }} /></Field>
        </div>
      </div>
    </Modal>}
  </>
}
