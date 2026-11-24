import { format } from 'date-fns'
import type { AssemblyTask } from '@/domain/types'
import type { AppData } from '@/hooks/useAppData'

export function canReportAssembly(task: AssemblyTask, data: AppData) {
  const today = format(new Date(), 'yyyy-MM-dd')
  return ['confirmed', 'partial', 'transferred'].includes(task.status) && task.productionDate <= today
    && !data.productionDays.some(({ date, status }) => date === today && status === 'closed')
    && data.employees.some(({ active }) => active)
}
