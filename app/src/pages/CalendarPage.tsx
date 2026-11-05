import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { ru } from 'date-fns/locale'
import { toast } from 'sonner'
import { useAppData } from '@/hooks/useAppData'
import { approveSchedule, updateSettings } from '@/persistence/repository'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader } from '@/ui/components'

export default function CalendarPage() {
  const data = useAppData(); const { unlocked, requestUnlock } = useAdmin()
  const [edit, setEdit] = useState(false); const [day, setDay] = useState(''); const [working, setWorking] = useState(false)
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
    <div className="notice mb-5"><strong>Правило хранения:</strong> готовность в выходной переносится на следующий рабочий день. Если фактическая дегазация превысит 6 дней, создаётся важная задача «Запаковать в Б/у».</div>
    {!tasks.length ? <Empty title="Календарь пуст" text="Даты появятся после регистрации лота." /> : <div className="grid gap-4">{Object.entries(groups).map(([date, items]) => <Card key={date}><div className="calendar-date"><time>{format(parseISO(date), 'd MMMM, EEEEEE', { locale: ru })}</time><Badge>{items.length}</Badge></div><div className="divide-y divide-border">{items.map((task) => { const lot = data.lots.find((item) => item.id === task.lotId); return <div className="calendar-task" key={task.id}><div><strong>{task.scheduleDecision === 'bu' ? 'Запаковать в Б/у · ' : ''}{lot?.country} / {lot?.name}</strong><p>{data.settings.formats.find((item) => item.id === task.formatId)?.name} · готовность {format(parseISO(task.readyDate), 'dd.MM')} · фактически {task.actualDegassingDays} дн.</p></div>{task.scheduleDecision !== 'none' && !task.approved ? <Button size="sm" variant="secondary" onClick={() => unlocked ? approveSchedule(task.id).then(() => toast.success('Перенос подтверждён')) : requestUnlock()}>Подтвердить</Button> : <Badge tone={task.inBU ? 'warning' : 'success'}>{task.inBU ? 'В Б/у' : 'Согласовано'}</Badge>}</div>})}</div></Card>)}</div>}
    {edit && <Modal title="Нерабочие и рабочие дни" onClose={() => setEdit(false)}><div className="grid gap-4"><Field label="Дата"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field><label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={working} onChange={(e) => setWorking(e.target.checked)} />Сделать рабочим днём (ручное исключение)</label><Button onClick={addDay}>Сохранить день</Button><div><h3 className="mb-2 font-semibold">Праздники и ручные нерабочие дни</h3><div className="flex flex-wrap gap-2">{data.settings.nonWorkingDays.map((item) => <Badge key={item}>{format(parseISO(item), 'dd.MM.yyyy')}</Badge>)}</div></div><p className="text-sm text-muted">Локальный календарь можно обновить здесь. Срок дегазации при этом всё равно считается календарными днями.</p></div></Modal>}
  </>
}
