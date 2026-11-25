import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { assemblyParticipantIds } from '@/domain/assemblyReports'
import type { AssemblyReport, AssemblyTask, Employee, ProductionEntry } from '@/domain/types'
import { correctAssemblyReport } from '@/persistence/actions'
import { correctProductionEntry, ProductionCorrectionConflict } from '@/persistence/actions'
import { AssemblyParticipants } from './AssemblyParticipants'
import { Button, Field, Input, Modal, Textarea } from './components'

export type ShiftCorrection = { type: 'production'; entry: ProductionEntry } | { type: 'assembly'; entry: AssemblyReport; task: AssemblyTask }

export function ShiftCorrectionDialog({ edit, employees, onClose }: { edit: ShiftCorrection; employees: Employee[]; onClose: () => void }) {
  const [quantity, setQuantity] = useState(String(edit.entry.quantity))
  const [reason, setReason] = useState('')
  const [participants, setParticipants] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  const number = Number(quantity)
  const needsParticipants = edit.type === 'assembly' && !assemblyParticipantIds(edit.entry).length && number > 0
  const validQuantity = quantity !== '' && Number.isSafeInteger(number) && number >= 0 && number !== edit.entry.quantity
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !validQuantity || !reason.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      if (edit.type === 'production') await correctProductionEntry(edit.entry.id, number, reason, edit.entry.quantity)
      else await correctAssemblyReport(edit.entry.id, number, reason, { expectedQuantity: edit.entry.quantity, participantIds: participants })
      toast.success('Исправление сохранено')
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure : new Error('Не удалось исправить отчёт'))
    } finally { setBusy(false) }
  }

  return <Modal title={edit.type === 'production' ? 'Исправить выпуск' : 'Исправить факт сборки'} onClose={() => { if (!busy) onClose() }}>
    <form className="grid gap-4" onSubmit={save}>
      <p className="notice">Прежнее количество {edit.entry.quantity} {edit.type === 'production' ? 'шт.' : 'наб.'}</p>
      <Field label="Новое количество"><Input type="number" min="0" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
      {needsParticipants && edit.type === 'assembly' && <AssemblyParticipants employees={employees} joint={edit.task.jointAssembly} selected={participants} onChange={setParticipants} />}
      <Field label="Причина исправления"><Textarea required value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      {error && <div role="alert" className="notice">
        <p>{error.message}</p>
        {edit.type === 'production' && error instanceof ProductionCorrectionConflict && <ul className="mt-2 grid gap-2">
          <li><Link className="underline" to={`/?lot=${encodeURIComponent(edit.entry.lotId)}`}>Сверить историю лота</Link></li>
          {error.taskIds.map((id, index) => <li key={id}><Link className="underline" to={`/assembly#task-${encodeURIComponent(id)}`}>Связанное задание {index + 1}</Link></li>)}
          {error.reportIds.map((id, index) => <li key={id}><Link className="underline" to={`/reports?assemblyReport=${encodeURIComponent(id)}`} onClick={onClose}>Связанный отчёт {index + 1}</Link></li>)}
        </ul>}
      </div>}
      <Button disabled={busy || !validQuantity || !reason.trim() || (needsParticipants && participants.length < (edit.type === 'assembly' && edit.task.jointAssembly ? 2 : 1))}>Сохранить исправление</Button>
    </form>
  </Modal>
}
