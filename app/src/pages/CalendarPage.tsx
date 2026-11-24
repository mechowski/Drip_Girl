import { useState, type FormEvent } from 'react'
import { format, parseISO } from 'date-fns'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { isCalendarDate, isWorkingDay, parseCalendarSource } from '@/domain/calendar'
import { DEFAULT_CALENDAR_SOURCE } from '@/domain/types'
import { useAppData } from '@/hooks/useAppData'
import { updateProductionCalendar } from '@/persistence/repository'
import { useAdmin } from '@/ui/AdminContext'
import { Button, Field, Input, Modal, PageHeader } from '@/ui/components'
import { ShiftCalendar } from '@/ui/ShiftCalendar'
import { buildShiftCalendarEntries } from '@/ui/shiftCalendarEntries'

const displayDate = (date: string) => format(parseISO(date), 'dd.MM.yyyy')

export default function CalendarPage() {
  const data = useAppData()
  const { unlocked } = useAdmin()
  const [edit, setEdit] = useState(false)
  const [day, setDay] = useState('')
  const [mode, setMode] = useState<'working' | 'closed' | 'default'>('closed')
  const [busy, setBusy] = useState(false)
  const [params] = useSearchParams()
  const dateParam = params.get('date')
  const now = new Date()
  const selectedDate = dateParam && isCalendarDate(dateParam) ? parseISO(dateParam) : undefined
  const monthEntries = buildShiftCalendarEntries(data, unlocked, true)
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
    if (updated) setDay('')
  }

  const importCalendar = (file: File) => run(async () => {
    const calendar = parseCalendarSource(JSON.parse(await file.text()))
    await updateProductionCalendar(calendar)
  }, 'Источник производственного календаря обновлён')

  return <>
    <PageHeader title="Календарь" description="Изготовление, сборка, дегазация и упаковка в Б/у" action={unlocked && <Button variant="secondary" onClick={() => setEdit(true)}>Настроить дни</Button>} />
    <ShiftCalendar key={dateParam} now={now} initialDay={selectedDate} full entries={monthEntries}
      isWorking={(date) => isWorkingDay(date, data.settings)} />
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
