import { addDays, differenceInCalendarDays, format, isWeekend, parseISO } from 'date-fns'
import type { AppSettings } from './types'

export const dayKey = (date: Date | string) => typeof date === 'string' ? date : format(date, 'yyyy-MM-dd')

export function isWorkingDay(date: Date | string, settings: AppSettings): boolean {
  const value = typeof date === 'string' ? parseISO(date) : date
  const key = dayKey(value)
  if (settings.workingOverrides.includes(key)) return true
  return !isWeekend(value) && !settings.nonWorkingDays.includes(key)
}

export function nextWorkingDay(date: Date | string, settings: AppSettings): Date {
  let cursor = typeof date === 'string' ? parseISO(date) : date
  for (let i = 0; i < 45; i += 1) {
    if (isWorkingDay(cursor, settings)) return cursor
    cursor = addDays(cursor, 1)
  }
  throw new Error('Не найден рабочий день в ближайшие 45 дней')
}

export function previousWorkingDay(date: Date | string, settings: AppSettings): Date {
  let cursor = addDays(typeof date === 'string' ? parseISO(date) : date, -1)
  for (let i = 0; i < 45; i += 1) {
    if (isWorkingDay(cursor, settings)) return cursor
    cursor = addDays(cursor, -1)
  }
  throw new Error('Не найден предыдущий рабочий день')
}

export function scheduleDegassing(roastDate: string, degassingDays: number, settings: AppSettings) {
  if (!Number.isInteger(degassingDays) || degassingDays < 1 || degassingDays > 5) throw new Error('Дегазация должна быть от 1 до 5 дней')
  const ready = addDays(parseISO(roastDate), degassingDays)
  if (isWorkingDay(ready, settings)) {
    return { readyDate: dayKey(ready), plannedDate: dayKey(ready), actualDays: degassingDays, decision: 'none' as const }
  }
  const next = nextWorkingDay(ready, settings)
  const actualDays = differenceInCalendarDays(next, parseISO(roastDate))
  if (actualDays <= 6) {
    return { readyDate: dayKey(ready), plannedDate: dayKey(next), actualDays, decision: 'move' as const }
  }
  const before = previousWorkingDay(ready, settings)
  return { readyDate: dayKey(ready), plannedDate: dayKey(before), actualDays: differenceInCalendarDays(before, parseISO(roastDate)), decision: 'bu' as const }
}
