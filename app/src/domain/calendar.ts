import { addDays, differenceInCalendarDays, format, isValid, isWeekend, parseISO } from 'date-fns'
import { z } from 'zod'
import { DEFAULT_CALENDAR_SOURCE, type AppSettings, type CalendarSource } from './types'

export const dayKey = (date: Date | string) => typeof date === 'string' ? date : format(date, 'yyyy-MM-dd')

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = parseISO(value)
  return isValid(date) && dayKey(date) === value
}

export const calendarSourceSchema = z.object({
  nonWorkingDays: z.array(z.string().refine(isCalendarDate)),
  workingDays: z.array(z.string().refine(isCalendarDate)),
})

export function parseCalendarSource(input: unknown): CalendarSource {
  const result = calendarSourceSchema.safeParse(input)
  if (!result.success) throw new Error('Укажите массивы nonWorkingDays и workingDays с датами в формате ГГГГ-ММ-ДД')
  const nonWorkingDays = [...new Set(result.data.nonWorkingDays)].sort()
  const workingDays = [...new Set(result.data.workingDays)].sort()
  const conflict = workingDays.find((day) => nonWorkingDays.includes(day))
  if (conflict) throw new Error(`Дата ${conflict} одновременно рабочая и нерабочая`)
  return { nonWorkingDays, workingDays }
}

export function isWorkingDay(date: Date | string, settings: AppSettings): boolean {
  const value = typeof date === 'string' ? parseISO(date) : date
  const key = dayKey(value)
  if (settings.workingOverrides.includes(key)) return true
  if (settings.nonWorkingDays.includes(key)) return false
  const source = settings.calendarSource ?? DEFAULT_CALENDAR_SOURCE
  if (source.workingDays.includes(key)) return true
  return !isWeekend(value) && !source.nonWorkingDays.includes(key)
}

export function nextWorkingDay(date: Date | string, settings: AppSettings): Date {
  let cursor = typeof date === 'string' ? parseISO(date) : date
  if (!isValid(cursor)) throw new Error('Укажите корректную дату')
  while (!isWorkingDay(cursor, settings)) cursor = addDays(cursor, 1)
  return cursor
}

export function previousWorkingDay(date: Date | string, settings: AppSettings): Date {
  let cursor = addDays(typeof date === 'string' ? parseISO(date) : date, -1)
  if (!isValid(cursor)) throw new Error('Укажите корректную дату')
  while (!isWorkingDay(cursor, settings)) cursor = addDays(cursor, -1)
  return cursor
}

export interface DegassingSchedule {
  readyDate: string
  plannedDate: string
  buDate?: string
  actualDays: number
  decision: 'none' | 'move' | 'bu'
}

export function assertDegassingDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 5) throw new Error('Дегазация должна быть от 1 до 5 дней')
}

export function scheduleDegassing(roastDate: string, degassingDays: number, settings: AppSettings): DegassingSchedule {
  if (!isCalendarDate(roastDate)) throw new Error('Укажите корректную дату обжарки')
  assertDegassingDays(degassingDays)
  const roast = parseISO(roastDate)
  const ready = addDays(roast, degassingDays)
  if (isWorkingDay(ready, settings)) {
    return { readyDate: dayKey(ready), plannedDate: dayKey(ready), actualDays: degassingDays, decision: 'none' as const }
  }
  const next = nextWorkingDay(ready, settings)
  const actualDays = differenceInCalendarDays(next, roast)
  if (actualDays <= 6) {
    return { readyDate: dayKey(ready), plannedDate: dayKey(next), actualDays, decision: 'move' as const }
  }
  const before = previousWorkingDay(ready, settings)
  return {
    readyDate: dayKey(ready),
    plannedDate: dayKey(next),
    buDate: dayKey(before),
    actualDays,
    decision: 'bu' as const,
  }
}

export function nextShiftDate(date: string, settings: AppSettings): string {
  return dayKey(nextWorkingDay(addDays(parseISO(date), 1), settings))
}
