import { useSearchParams } from 'react-router'
import { ShiftCorrectionDialog, type ShiftCorrection } from '@/ui/ShiftCorrectionDialog'
import { useState } from 'react'
import { Archive, CheckCheck } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { useAppData, type AppData } from '@/hooks/useAppData'
import { formatNumber } from '@/domain/calculations'
import { assemblyByComposition, productionByLot } from '@/domain/shiftReport'
import { summarizeAssembly } from '@/persistence/actions'
import { ShiftCloseDialog } from '@/ui/ShiftCloseDialog'
import { useAdmin } from '@/ui/AdminContext'
import { Button, Card, Modal, PageHeader } from '@/ui/components'
import type { DailyReport } from '@/domain/types'

const displayDate = (date: string) => format(parseISO(date), 'dd.MM.yyyy')
type ShiftData = Pick<DailyReport, 'produced' | 'assembled' | 'warnings'>

export default function ReportsPage() {
  const data = useAppData()
  const { unlocked } = useAdmin()
  const [closeOpen, setCloseOpen] = useState(false)
  const [params, setParams] = useSearchParams()
  const [correction, setCorrection] = useState<ShiftCorrection>()
  const linkedReport = data.assemblyReports.find(({ id }) => id === params.get('assemblyReport'))
  const today = format(new Date(), 'yyyy-MM-dd')
  const archived = data.dailyReports.find((report) => report.date === today)
  const selected = data.dailyReports.find(({ id, date }) => id === params.get('report') || date === linkedReport?.productionDate)
  const dayClosed = Boolean(archived) || data.productionDays.some((day) => day.date === today && day.status === 'closed')
  const warnings = unlocked ? data.warnings.filter((item) => !item.read) : []
  const shift = archived ?? {
    produced: data.productionEntries.filter((entry) => format(parseISO(entry.createdAt), 'yyyy-MM-dd') === today),
    assembled: summarizeAssembly(data.assemblyTasks, data.assemblyReports.filter((report) => report.productionDate === today), today),
    warnings,
  }
  return <>
    <PageHeader title="Отчёты" description={displayDate(today)} action={unlocked &&
      <Button disabled={dayClosed} onClick={() => setCloseOpen(true)}><CheckCheck size={18} aria-hidden="true" />{dayClosed ? 'День завершён' : 'Завершить производственный день'}</Button>
    } />
    <div className="report-layout">
      <section>
        <div className="section-title"><h2>Текущая смена</h2></div>
        <ShiftDetails data={data} showWarnings={unlocked} shift={shift} />
      </section>
      <aside>
        <div className="section-title"><h2>Архив</h2><Archive size={19} aria-hidden="true" /></div>
        {!data.dailyReports.length ? <Card><p className="text-muted">Здесь появятся отчёты закрытых смен.</p></Card> : <div className="grid gap-3">
          {[...data.dailyReports].sort((a, b) => b.date.localeCompare(a.date)).map((report) => <Card key={report.id}>
            <button className="w-full text-left" onClick={() => setParams({ report: report.id })}>
              <time className="font-semibold" dateTime={report.date}>{displayDate(report.date)}</time>
              <p className="mt-1 text-sm text-muted">Выпущено: {formatNumber(report.produced.reduce((sum, entry) => sum + entry.quantity, 0))} шт.<br />Собрано: {formatNumber(report.assembled.reduce((sum, item) => sum + item.fact, 0))} наб.</p>
            </button>
          </Card>)}
        </div>}
      </aside>
    </div>
    {unlocked && closeOpen && <ShiftCloseDialog date={today} data={data} onClose={() => setCloseOpen(false)} />}
    {selected && !correction && <Modal title={`Архивный отчёт за ${displayDate(selected.date)}`} onClose={() => setParams({})} wide>
      <ShiftDetails data={data} showWarnings={unlocked} shift={selected} />
      {unlocked && <section className="mt-4 grid gap-4">
        <h3 className="font-semibold">Записи смены</h3>
        {selected.produced.map((entry) => {
          const lot = data.lots.find(({ id }) => id === entry.lotId)
          return <div className="detail-line" key={entry.id}>
            <span>{lot ? `${lot.country} / ${lot.name}` : 'Лот'} · {displayDate(format(new Date(entry.createdAt), 'yyyy-MM-dd'))} {format(new Date(entry.createdAt), 'HH:mm')} · {formatNumber(entry.quantity)} шт.</span>
            <Button size="sm" variant="secondary" onClick={() => setCorrection({ type: 'production', entry })}>Исправить выпуск</Button>
          </div>
        })}
        {data.assemblyReports.filter(({ productionDate }) => productionDate === selected.date).map((entry) => {
          const task = data.assemblyTasks.find(({ id }) => id === entry.taskId)
          return task && <div className="detail-line" key={entry.id}>
            <span>{task.name} · {format(new Date(entry.createdAt), 'HH:mm')} · {formatNumber(entry.quantity)} наб.</span>
            <Button size="sm" variant="secondary" onClick={() => setCorrection({ type: 'assembly', entry, task })}>Исправить факт сборки</Button>
          </div>
        })}
      </section>}
    </Modal>}
    {linkedReport && !selected && !correction && <Modal title="Отчёт сборки" onClose={() => setParams({})}>
      <p>{data.assemblyTasks.find(({ id }) => id === linkedReport.taskId)?.name} · {formatNumber(linkedReport.quantity)} наб. · {displayDate(linkedReport.productionDate)}</p>
    </Modal>}
    {correction && unlocked && <ShiftCorrectionDialog edit={correction} employees={data.employees} onClose={() => setCorrection(undefined)} />}
  </>
}

function ShiftDetails({ data, shift, showWarnings }: { data: AppData; shift: ShiftData; showWarnings: boolean }) {
  const produced = productionByLot(shift.produced)
  const assembled = assemblyByComposition(shift.assembled, data.assemblyTasks)
  const duplicateNames = new Set(assembled.filter((row, index) => assembled.findIndex(({ name }) => name === row.name) !== index).map(({ name }) => name))
  return <div className="grid gap-4 lg:grid-cols-2">
    <Card>
      <div className="section-title"><h3 className="font-semibold">Изготовление</h3><span>{formatNumber(produced.reduce((sum, row) => sum + row.quantity, 0))} шт.</span></div>
      {!produced.length && <p className="text-muted">Операций выпуска нет.</p>}
      <div className="divide-y divide-border">{produced.map((row) => {
        const lot = data.lots.find((item) => item.id === row.lotId)
        const formats = new Map<string, number>()
        for (const [taskId, quantity] of row.byTask) {
          const task = data.productionTasks.find(({ id }) => id === taskId)
          const name = data.settings.formats.find(({ id }) => id === task?.formatId)?.name
          if (name) formats.set(name, (formats.get(name) ?? 0) + quantity)
        }
        return <div className="history-line" key={row.lotId}>
          <div><strong>{lot ? `${lot.country} / ${lot.name}` : 'Лот'}</strong>
            {lot && <p>Обжарка {displayDate(lot.roastDate)}</p>}
            {formats.size > 1 && <p>{[...formats].map(([name, quantity]) => `${name} · ${formatNumber(quantity)} шт.`).join(', ')}</p>}
          </div>
          <strong>{formatNumber(row.quantity)} шт.</strong>
        </div>
      })}</div>
    </Card>
    <Card>
      <div className="section-title"><h3 className="font-semibold">Сборка</h3><span>{formatNumber(assembled.reduce((sum, item) => sum + item.fact, 0))} наб.</span></div>
      {!assembled.length && <p className="text-muted">Заданий и отчётов нет.</p>}
      <div className="divide-y divide-border">{assembled.map((item) => <div className="history-line" key={item.id}>
        <div><strong>{item.name}</strong>
          {duplicateNames.has(item.name) && item.items && <p>{item.items.map(({ country, coffeeName, quantityPerSet }) => `${country} / ${coffeeName} · ${quantityPerSet} шт.`).join(', ')}</p>}
          {item.comments.map((comment, index) => <p key={index}>{comment}</p>)}
        </div>
        <div><strong>Собрано {formatNumber(item.fact)} из {formatNumber(item.plan)}</strong>{item.remaining > 0 && <p>Осталось {formatNumber(item.remaining)} наб.</p>}</div>
      </div>)}</div>
    </Card>
    {showWarnings && shift.warnings.length > 0 && <Card className="lg:col-span-2"><h3 className="mb-2 font-semibold">Предупреждения</h3><ul className="grid gap-2">{shift.warnings.map((warning) => <li key={warning.id}>{warning.message}</li>)}</ul></Card>}
  </div>
}
