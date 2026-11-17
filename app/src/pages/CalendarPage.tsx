import { useState } from 'react'
import { addDays, format, parseISO, startOfWeek } from 'date-fns'
import { ru } from 'date-fns/locale'
import { toast } from 'sonner'
import { useAppData } from '@/hooks/useAppData'
import { approveSchedule, updateSettings } from '@/persistence/repository'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader } from '@/ui/components'

export default function CalendarPage() {
  const data = useAppData(); const { unlocked, requestUnlock } = useAdmin()
  const [edit, setEdit] = useState(false); const [day, setDay] = useState(''); const [working, setWorking] = useState(false)
  const [week, setWeek] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index))
  const tasks = [...data.productionTasks].sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))
  const groups = tasks.reduce<Record<string, typeof tasks>>((acc, task) => ({ ...acc, [task.plannedDate]: [...(acc[task.plannedDate] ?? []), task] }), {})
  const addDay = async () => {
    if (!day) return
    const nonWorkingDays = working ? data.settings.nonWorkingDays.filter((item) => item !== day) : [...new Set([...data.settings.nonWorkingDays, day])]
    const workingOverrides = working ? [...new Set([...data.settings.workingOverrides, day])] : data.settings.workingOverrides.filter((item) => item !== day)
    await updateSettings({ nonWorkingDays, workingOverrides }); toast.success('Производственный календарь обновлён'); setDay('')
  }
  return <>
    <PageHeader title="Календарь" description="Дегазация по календарным дням, изготовление только в рабочие дни" action={<Button variant="secondary" onClick={() => unlocked ? setEdit(true) : requestUnlock()}>Настроить дни</Button>} />
    <div className="release-result mb-4">
      <Button size="sm" variant="secondary" onClick={() => setWeek(addDays(week, -7))}>Предыдущая неделя</Button>
      <strong>{format(week, 'd MMMM', { locale: ru })} — {format(days[6], 'd MMMM', { locale: ru })}</strong>
      <Button size="sm" variant="secondary" onClick={() => setWeek(addDays(week, 7))}>Следующая неделя</Button>
    </div>
    <div className="calendar-week">{days.map((value) => {
      const date = format(value, 'yyyy-MM-dd')
      const ready = new Set(tasks.filter((task) => task.readyDate === date).map((task) => task.lotId))
      return <Card key={date}><div className="calendar-date"><time dateTime={date}>{format(value, 'EEE d', { locale: ru })}</time></div>
        <p className="text-sm text-muted">Готовых лотов: <strong>{ready.size}</strong></p>
        {groups[date]?.map((task) => {
          const lot = data.lots.find((item) => item.id === task.lotId)
          const shifted = task.scheduleDecision !== 'none'
          return <div className="calendar-week-task" key={task.id}>
            <strong>{lot ? `${lot.country} / ${lot.name}` : 'Лот'}</strong>
            {shifted && <p className="text-sm text-muted">С {format(parseISO(task.readyDate), 'dd.MM')} на {format(value, 'dd.MM')}. {task.scheduleDecision === 'bu' ? 'Дегазация превысит 6 дней — нужна упаковка в Б/у.' : 'Исходная дата выпадает на нерабочий день.'}</p>}
            {shifted && !task.approved && <Button size="sm" variant="secondary" onClick={() => unlocked ? approveSchedule(task.id).then(() => toast.success('Перенос подтверждён')).catch((error: Error) => toast.error(error.message)) : requestUnlock()}>Подтвердить</Button>}
          </div>
        })}
      </Card>
    })}</div>
    {!tasks.length && <div className="mt-4"><Empty title="Календарь пуст" text="Даты появятся после регистрации лота." /></div>}
    {edit && <Modal title="Нерабочие и рабочие дни" onClose={() => setEdit(false)}><div className="grid gap-4"><Field label="Дата"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field><label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={working} onChange={(e) => setWorking(e.target.checked)} />Сделать рабочим днём (ручное исключение)</label><Button onClick={addDay}>Сохранить день</Button><div><h3 className="mb-2 font-semibold">Праздники и ручные нерабочие дни</h3><div className="flex flex-wrap gap-2">{data.settings.nonWorkingDays.map((item) => <Badge key={item}>{format(parseISO(item), 'dd.MM.yyyy')}</Badge>)}</div></div><p className="text-sm text-muted">Локальный календарь можно обновить здесь. Срок дегазации при этом всё равно считается календарными днями.</p></div></Modal>}
  </>
}
