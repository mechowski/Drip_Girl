import { lazy, Suspense, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { format, parseISO } from 'date-fns'
import { formatNumber } from '@/domain/calculations'
import { useAppData } from '@/hooks/useAppData'
import { useAdmin } from './AdminContext'
import { Modal } from './components'
import { ProductionReceiptNotice, ProductionTaskDialog, type ProductionReceipt } from './ProductionTaskDialog'
import { QuickViewContext, type QuickView } from './QuickViewContext'
import { QuickViewLink } from './QuickViewLink'
import { AssemblyReportDialog } from './AssemblyReportDialog'
import { canReportAssembly } from './assemblyReportAvailability'

const LotsPage = lazy(() => import('@/pages/LotsPage'))

export function QuickViews({ children }: { children: ReactNode }) {
  const [views, setViews] = useState<{ view: QuickView; trigger: HTMLElement }[]>([])
  const [receipt, setReceipt] = useState<ProductionReceipt>()
  const current = views.at(-1)
  const close = () => {
    setViews((previous) => previous.slice(0, -1))
    requestAnimationFrame(() => { if (current?.trigger.isConnected) current.trigger.focus() })
  }
  return <QuickViewContext.Provider value={(view, trigger) => setViews((previous) => [...previous, { view, trigger }])}>
    {receipt && <ProductionReceiptNotice receipt={receipt} />}
    {children}
    {views.map(({ view }, index) => <QuickViewDialog key={`${index}-${view.kind}-${view.id}`} view={view} onClose={close} onReceipt={setReceipt} />)}
  </QuickViewContext.Provider>
}

function QuickViewDialog({ view, onClose, onReceipt }: { view: QuickView; onClose: () => void; onReceipt: (receipt: ProductionReceipt) => void }) {
  const data = useAppData()
  const { unlocked } = useAdmin()
  const [reporting, setReporting] = useState(false)
  const date = (value: string) => format(parseISO(value), 'dd.MM.yyyy')

  if (view.kind === 'production') return <ProductionTaskDialog taskId={view.id} initialMode={view.mode} onClose={onClose} onReceipt={onReceipt} />
  if (view.kind === 'lot' && data.lots.some(({ id }) => id === view.id) || view.kind === 'new-lot' && unlocked) {
    return <Suspense fallback={<Modal title="Лот" onClose={onClose}><p>Загрузка…</p></Modal>}>
      <LotsPage quickLot={view.kind === 'new-lot' ? 'new' : { id: view.id }} onQuickClose={onClose} />
    </Suspense>
  }
  if (view.kind === 'assembly') {
    const task = data.assemblyTasks.find(({ id }) => id === view.id)
    if (task && (unlocked || !['draft', 'pending', 'cancelled'].includes(task.status))) {
      const canReport = canReportAssembly(task, data)
      if (reporting && canReport) return <AssemblyReportDialog task={task} onClose={onClose} />
      return <Modal title={task.name} onClose={onClose}>
        <div className="task-dialog-summary"><p>Смена {date(task.productionDate)}</p><dl>
          <div><dt>План</dt><dd>{formatNumber(task.plannedQuantity)} наб.</dd></div>
          <div><dt>Собрано</dt><dd>{formatNumber(task.completedQuantity)} наб.</dd></div>
          <div><dt>Осталось</dt><dd>{formatNumber(task.plannedQuantity - task.completedQuantity)} наб.</dd></div>
        </dl></div>
        <ul className="shift-day-plan">{task.compositionSnapshot.map((item) => <li key={item.id}>{item.country} / {item.coffeeName} · {item.quantityPerSet} шт. в наборе</li>)}</ul>
        {task.comment && <p className="mt-3 text-sm">{task.comment}</p>}
        <div className="modal-actions">
          <Link className="button button-secondary" to={`/assembly#task-${task.id}`} onClick={onClose}>Перейти в сборку</Link>
          {canReport && <button className="button button-primary" type="button" onClick={() => setReporting(true)}>Отчитаться</button>}
        </div>
      </Modal>
    }
  }
  if (view.kind === 'plan' && unlocked) {
    const plan = data.assemblyPlans.find(({ id }) => id === view.id)
    if (plan) return <Modal title="План сборки" onClose={onClose}>
      <div className="task-dialog-summary"><p>{date(plan.date)} · {plan.status === 'draft' ? 'Ожидает резерва' : 'Резерв подтверждён'}</p></div>
      <ul className="shift-day-plan">{data.assemblyTasks.filter(({ planId }) => planId === plan.id).map((task) => <li key={task.id}>
        <QuickViewLink to={`/assembly#task-${task.id}`}>{task.name}</QuickViewLink><p>{formatNumber(task.plannedQuantity)} наб.</p>
      </li>)}</ul>
      <div className="modal-actions"><Link className="button button-secondary" to={`/assembly#plan-${plan.id}`} onClick={onClose}>Перейти к плану</Link></div>
    </Modal>
  }
  if (view.kind === 'composition') {
    const composition = [...data.manualCompositions, ...data.importedCompositions].find(({ id }) => id === view.id)
    if (composition) return <Modal title={composition.name} onClose={onClose}>
      <ul className="shift-day-plan">{composition.items.map((item) => <li key={item.id}>{item.country} / {item.coffeeName} · {item.quantityPerSet} шт. в наборе</li>)}</ul>
      <div className="modal-actions"><Link className="button button-secondary" to={`/compositions?composition=${encodeURIComponent(composition.id)}`} onClick={onClose}>Перейти к составу</Link></div>
    </Modal>
  }
  return <Modal title="Подробности" onClose={onClose}><p>Запись недоступна.</p></Modal>
}
