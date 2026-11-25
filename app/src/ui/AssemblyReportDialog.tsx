import { useState, type FormEvent } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import type { AssemblyTask } from '@/domain/types'
import { useAppData } from '@/hooks/useAppData'
import { reportAssembly } from '@/persistence/repository'
import { canReportAssembly } from './assemblyReportAvailability'
import { Button, Field, Input, Modal, Textarea } from './components'

export function AssemblyReportDialog({ task, onClose }: { task: AssemblyTask; onClose: () => void }) {
  const data = useAppData()
  const awaitingOutput = data.expectedReservations.some(({ assemblyTaskId }) => assemblyTaskId === task.id)
  const remaining = task.plannedQuantity - task.completedQuantity
  const [quantity, setQuantity] = useState(remaining)
  const [employeeId, setEmployeeId] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !canReportAssembly(task, data)) return
    setBusy(true)
    try {
      await reportAssembly(task.id, employeeId, quantity, comment)
      toast.success(awaitingOutput ? 'Отчёт принят' : 'Отчёт принят, сток списан по FIFO')
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка операции')
    } finally { setBusy(false) }
  }
  return <Modal title={`Отчёт: ${task.name}`} onClose={() => { if (!busy) onClose() }}>
    <form className="grid gap-4" onSubmit={submit}>
      <div className="notice">Осталось {remaining} наборов. {awaitingOutput
        ? 'Дрипы из ожидаемого выпуска спишутся при его внесении на сток.'
        : 'Списание произойдёт при отправке отчёта.'}</div>
      <Field label="Сборщик"><select className="field-control" required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">Выберите фамилию</option>{data.employees.filter(({ active }) => active).map((item) => <option value={item.id} key={item.id}>{item.lastName} {item.firstName}</option>)}</select></Field>
      <Field label="Фактически собрано наборов"><Input required type="number" min="1" max={remaining} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></Field>
      <Field label="Комментарий или брак"><Textarea value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
      <Button disabled={busy || !canReportAssembly(task, data)}><CheckCircle2 size={17} />Отправить отчёт</Button>
    </form>
  </Modal>
}
