import { format } from 'date-fns'
import { Link } from 'react-router'
import { formatNumber } from '@/domain/calculations'
import type { AppData } from '@/hooks/useAppData'
import { QuickViewLink } from './QuickViewLink'

const labels = { receipt: 'Приход', reserve: 'Резерв', release: 'Снятие резерва', consume: 'Списание', adjust: 'Корректировка', writeoff: 'Списание', reassign: 'Переназначение' }
const shiftLink = (id: string) => `/reports?report=${encodeURIComponent(id)}`

export function LotHistory({ lotId, data }: { lotId: string; data: AppData }) {
  const batchIds = new Set(data.inventory.filter(({ sourceLotId }) => sourceLotId === lotId).map(({ id }) => id))
  const reports = new Map(data.assemblyReports.map((row) => [row.id, row]))
  const archives = new Map(data.dailyReports.map((row) => [row.date, row]))
  const entries = data.productionEntries.filter((entry) => entry.lotId === lotId)
  const events = [
    ...entries.map((entry) => ({
      id: entry.id, at: entry.createdAt, label: 'Изготовление', amount: `${formatNumber(entry.quantity)} шт.`, description: entry.comment,
      job: `/production?task=${encodeURIComponent(entry.taskId)}`,
      archive: data.dailyReports.find(({ produced }) => produced.some(({ id }) => id === entry.id))?.id,
      link: entry.moySkladLink,
    })),
    ...data.inventoryTransactions.filter(({ inventoryLotId }) => batchIds.has(inventoryLotId)).map((row) => ({
      id: row.id, at: row.createdAt, label: labels[row.type], amount: `${row.quantity > 0 ? '+' : ''}${formatNumber(row.quantity)}`,
      description: [row.author, row.reason, row.comment, row.type === 'adjust' ? `${formatNumber(row.previousQuantity)} → ${formatNumber(row.newQuantity)} шт.` : undefined].filter(Boolean).join(' · '),
      job: row.assemblyTaskId ? `/assembly#task-${encodeURIComponent(row.assemblyTaskId)}` : undefined,
      archive: row.reportId ? archives.get(reports.get(row.reportId)?.productionDate ?? '')?.id : undefined,
      link: undefined,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  return <section aria-label="История лота">
    <h3 className="mb-3 font-semibold">История операций</h3>
    {!events.length && <p className="text-sm text-muted">Операций по лоту пока нет.</p>}
    <div className="divide-y divide-border">{events.map((row) => <div className="history-line" key={row.id}>
      <div><strong>{row.label}</strong>{row.description && <p>{row.description}</p>}
        <div className="flex flex-wrap gap-2 text-sm">
          {row.job && <QuickViewLink className="underline" to={row.job}>Задание</QuickViewLink>}
          {row.archive && <Link className="underline" to={shiftLink(row.archive)}>Отчёт смены</Link>}
          {row.link && <a className="underline" href={row.link} target="_blank" rel="noreferrer">Техоперация в МоемСкладе</a>}
        </div>
      </div>
      <div><strong>{row.amount}</strong><time dateTime={row.at}>{format(new Date(row.at), 'dd.MM.yyyy HH:mm')}</time></div>
    </div>)}</div>
  </section>
}
