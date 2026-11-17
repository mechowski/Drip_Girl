import { useState } from 'react'
import { Archive, CheckCheck } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import { useAppData, type AppData } from '@/hooks/useAppData'
import { nextShiftDate } from '@/domain/calendar'
import { formatNumber } from '@/domain/calculations'
import { closeProductionDay, summarizeAssembly, tasksToTransfer } from '@/persistence/repository'
import { useAdmin } from '@/ui/AdminContext'
import { Button, Card, Modal, PageHeader } from '@/ui/components'
import type { DailyReport } from '@/domain/types'

const displayDate = (date: string) => format(parseISO(date), 'dd.MM.yyyy')
type ShiftData = Pick<DailyReport, 'produced' | 'assembled' | 'warnings'>

export default function ReportsPage() {
  const data = useAppData()
  const { unlocked, requestUnlock } = useAdmin()
  const [closeOpen, setCloseOpen] = useState(false)
  const [selected, setSelected] = useState<DailyReport | null>(null)
  const [busy, setBusy] = useState(false)
  const today = format(new Date(), 'yyyy-MM-dd')
  const archived = data.dailyReports.find((report) => report.date === today)
  const dayClosed = Boolean(archived) || data.productionDays.some((day) => day.date === today && day.status === 'closed')
  const warnings = data.warnings.filter((item) => !item.read)
  const shift = archived ?? {
    produced: data.productionEntries.filter((entry) => format(parseISO(entry.createdAt), 'yyyy-MM-dd') === today),
    assembled: summarizeAssembly(data.assemblyTasks, data.assemblyReports.filter((report) => report.productionDate === today), data.employees, today),
    warnings,
  }
  const transfers = tasksToTransfer(data.assemblyTasks, today)
  let nextDate = ''
  if (closeOpen) {
    try { nextDate = nextShiftDate(today, data.settings) } catch { /* The dialog shows the calendar error before confirmation. */ }
  }
  const closeDay = async () => {
    setBusy(true)
    try {
      await closeProductionDay(today)
      toast.success('День завершён, отчёт сохранён в архив')
      setCloseOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось завершить смену')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <PageHeader title="Отчёты" description={displayDate(today)} action={
      <Button disabled={dayClosed} onClick={() => unlocked ? setCloseOpen(true) : requestUnlock()}><CheckCheck size={18} aria-hidden="true" />{dayClosed ? 'День завершён' : 'Завершить день'}</Button>
    } />
    <div className="report-layout">
      <section>
        <div className="section-title"><h2>Текущая смена</h2></div>
        <ShiftDetails data={data} shift={shift} />
      </section>
      <aside>
        <div className="section-title"><h2>Архив</h2><Archive size={19} aria-hidden="true" /></div>
        {!data.dailyReports.length ? <Card><p className="text-muted">Здесь появятся отчёты закрытых смен.</p></Card> : <div className="grid gap-3">
          {[...data.dailyReports].sort((a, b) => b.date.localeCompare(a.date)).map((report) => <Card key={report.id}>
            <button className="w-full text-left" onClick={() => setSelected(report)}>
              <time className="font-semibold" dateTime={report.date}>{displayDate(report.date)}</time>
              <p className="mt-1 text-sm text-muted">Выпущено: {formatNumber(report.produced.reduce((sum, entry) => sum + entry.quantity, 0))} шт.<br />Собрано: {formatNumber(report.assembled.reduce((sum, item) => sum + item.fact, 0))} наб.</p>
            </button>
          </Card>)}
        </div>}
      </aside>
    </div>
    {closeOpen && <Modal title="Завершить производственный день?" onClose={() => { if (!busy) setCloseOpen(false) }} wide>
      <div className="grid gap-4">
        {!nextDate ? <p role="alert" className="notice">В ближайшие 45 дней нет рабочего дня. Проверьте настройки календаря.</p> : transfers.length ? <section>
          <h3 className="mb-2 font-semibold">Перенос на {displayDate(nextDate)}</h3>
          <ul className="divide-y divide-border">{transfers.map((task) => <li className="detail-line" key={task.id}><span>{task.name}</span><strong>{formatNumber(task.plannedQuantity - task.completedQuantity)} наб.</strong></li>)}</ul>
          <p className="mt-2 text-sm text-muted">Резервы этих заданий сохранятся.</p>
        </section> : <p>Заданий к переносу нет.</p>}
        {warnings.slice(0, 5).map((warning) => <div className="notice" key={warning.id}>{warning.message}</div>)}
        <div className="modal-actions">
          <Button variant="ghost" disabled={busy} onClick={() => setCloseOpen(false)}>Вернуться</Button>
          <Button disabled={busy || !nextDate} onClick={closeDay}>Подтвердить завершение</Button>
        </div>
      </div>
    </Modal>}
    {selected && <Modal title={`Архивный отчёт за ${displayDate(selected.date)}`} onClose={() => setSelected(null)} wide>
      <ShiftDetails data={data} shift={selected} />
    </Modal>}
  </>
}

function ShiftDetails({ data, shift }: { data: AppData; shift: ShiftData }) {
  return <div className="grid gap-4">
    <Card>
      <div className="section-title"><h3 className="font-semibold">Выпуск</h3><span>{formatNumber(shift.produced.reduce((sum, entry) => sum + entry.quantity, 0))} шт.</span></div>
      {!shift.produced.length && <p className="text-muted">Операций выпуска нет.</p>}
      <div className="divide-y divide-border">{shift.produced.map((entry) => {
        const lot = data.lots.find((item) => item.id === entry.lotId)
        const employee = data.employees.find((item) => item.id === entry.responsibleId)
        return <div className="history-line" key={entry.id}>
          <div><strong>{lot ? `${lot.country} / ${lot.name}` : 'Лот'}</strong>{employee && <p>{employee.lastName} {employee.firstName}</p>}{entry.comment && <p>{entry.comment}</p>}</div>
          <div><strong>{formatNumber(entry.quantity)} шт.</strong><time dateTime={entry.createdAt}>{format(parseISO(entry.createdAt), 'HH:mm')}</time></div>
        </div>
      })}</div>
    </Card>
    <Card>
      <div className="section-title"><h3 className="font-semibold">Сборка</h3><span>{formatNumber(shift.assembled.reduce((sum, item) => sum + item.fact, 0))} наб.</span></div>
      {!shift.assembled.length && <p className="text-muted">Заданий и отчётов нет.</p>}
      <div className="divide-y divide-border">{shift.assembled.map((item) => <div className="history-line" key={item.taskId}>
        <div><strong>{item.name}</strong><p>{item.employees.join(', ') || 'Отчётов нет'}</p>{item.comments.map((comment, index) => <p key={index}>{comment}</p>)}</div>
        <div><strong>Собрано {formatNumber(item.fact)} из {formatNumber(item.plan)}</strong><p>Осталось {formatNumber(item.remaining)} наб.</p></div>
      </div>)}</div>
    </Card>
    {shift.warnings.length > 0 && <Card><h3 className="mb-2 font-semibold">Предупреждения</h3><ul className="grid gap-2">{shift.warnings.map((warning) => <li key={warning.id}>{warning.message}</li>)}</ul></Card>}
  </div>
}
