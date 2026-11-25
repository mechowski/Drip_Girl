import type { AssemblyReport, AssemblyTask, Employee } from './types'

export function assemblyParticipantIds(report: Pick<AssemblyReport, 'employeeId' | 'participantIds'>) {
  return report.participantIds ?? [report.employeeId]
}

export function assemblyParticipantNames(report: Pick<AssemblyReport, 'employeeId' | 'participantIds'>, employees: Employee[]) {
  return assemblyParticipantIds(report).map((id) => {
    const person = employees.find((row) => row.id === id)
    return person ? `${person.lastName} ${person.firstName}` : 'Неизвестно'
  })
}

export function assemblyDripShares(task: Pick<AssemblyTask, 'compositionSnapshot'>, report: Pick<AssemblyReport, 'employeeId' | 'participantIds' | 'quantity'>) {
  const participants = assemblyParticipantIds(report)
  const perSet = task.compositionSnapshot.reduce((sum, item) => sum + item.quantityPerSet, 0)
  return participants.map((employeeId) => ({ employeeId, quantity: report.quantity * perSet / participants.length }))
}
