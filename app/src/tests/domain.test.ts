import { describe, expect, it } from 'vitest'
import { addDays } from 'date-fns'
import { buildProductionTasks, compositionCapacity, distributeAllocationWeights, plannedOutput, remainingCoffee, validateAllocations } from '@/domain/calculations'
import { dayKey, isWorkingDay, nextWorkingDay, parseCalendarSource, previousWorkingDay, scheduleDegassing } from '@/domain/calendar'
import { DEFAULT_SETTINGS, type CompositionItem, type InventoryLot } from '@/domain/types'
import { parseCompositionSheet, parseCsv } from '@/integrations/googleSheets'

const item = (name: string, quantityPerSet: number): CompositionItem => ({ id: name, country: 'Страна', coffeeName: name, formatId: 'drip', quantityPerSet })
const stock = (name: string, quantity: number, reserved = 0): InventoryLot => ({ id: name, sourceLotId: name, productionTaskId: 't', country: 'Страна', coffeeName: name, formatId: 'drip', purpose: '×16', quantity, reserved, manufacturedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', inBU: false })

describe('производственные расчёты', () => {
  it.each([[0.0121, 12.1, 1000], [0.022, 22, 1000], [0.035, 3.5, 100], [0.07, 7, 100]])('коэффициент %s и округление вниз', (coefficient, weight, result) => {
    expect(plannedOutput(weight, coefficient)).toBe(result)
    expect(plannedOutput(0.01209, 0.0121)).toBe(0)
  })
  it('контролирует дробление и нераспределённый остаток', () => {
    expect(validateAllocations(5, [{ weightKg: 3 }, { weightKg: 2 }])).toBeNull()
    expect(validateAllocations(5, [{ weightKg: 3 }, { weightKg: 2.01 }])).toContain('превышают')
    expect(validateAllocations(5, [{ weightKg: 0 }])).toContain('положительным числом')
  })
  it('поровну распределяет вес и сохраняет вручную заданные доли', () => {
    expect(distributeAllocationWeights('12', [undefined])).toEqual(['12'])
    expect(distributeAllocationWeights('12', [undefined, undefined])).toEqual(['6', '6'])
    expect(distributeAllocationWeights('12', ['8.5', undefined])).toEqual(['8.5', '3.5'])
    expect(distributeAllocationWeights('12', ['8', undefined, undefined])).toEqual(['8', '2', '2'])
    expect(distributeAllocationWeights('12', ['13', undefined])).toEqual(['13', '0'])
    const fractions = distributeAllocationWeights('1', [undefined, undefined, undefined])
    expect(fractions.reduce((sum, weight) => sum + Number(weight), 0)).toBeCloseTo(1, 12)
  })
  it('разделяет задачи по формату и назначению', () => {
    const lot = { id: 'lot', country: 'Эфиопия', name: 'Гуджи', roastDate: '2026-11-02', weightKg: 12, degassingDays: 3, createdAt: '2026-11-02' }
    const allocations = [
      { id: 'a', lotId: 'lot', formatId: 'drip' as const, purpose: '×6', weightKg: 5 },
      { id: 'b', lotId: 'lot', formatId: 'drip' as const, purpose: '×16', weightKg: 3, degassingDays: 5 },
      { id: 'c', lotId: 'lot', formatId: 'mega' as const, purpose: 'Мега', weightKg: 2 },
      { id: 'd', lotId: 'lot', formatId: 'smol30' as const, purpose: '30 г', weightKg: 2 },
    ]
    const tasks = buildProductionTasks(lot, allocations, DEFAULT_SETTINGS, scheduleDegassing)
    expect(tasks).toHaveLength(4)
    expect(tasks.find((task) => task.purpose === '×6')).toMatchObject({ sourceWeightKg: 5, readyDate: '2026-11-05' })
    expect(tasks.find((task) => task.purpose === '×16')).toMatchObject({ sourceWeightKg: 3, readyDate: '2026-11-07', plannedDate: '2026-11-09', buDate: '2026-11-06' })
  })
  it('считает частичное изготовление и списание без отрицательного остатка', () => {
    const format = DEFAULT_SETTINGS.formats[0]
    expect(remainingCoffee({ sourceWeightKg: 12.1, producedQuantity: 600, writtenOffKg: 0 }, format)).toBeCloseTo(4.84)
    expect(remainingCoffee({ sourceWeightKg: 1, producedQuantity: 100, writtenOffKg: 0 }, format)).toBe(0)
  })
})

describe('календарь', () => {
  const settings = { ...DEFAULT_SETTINGS, calendarSource: { nonWorkingDays: [], workingDays: [] }, nonWorkingDays: ['2026-01-01', '2026-01-02'], workingOverrides: [] }
  it.each([1, 2, 3, 4, 5])('готовность по календарным дням: %d', (days) => {
    expect(scheduleDegassing('2026-01-01', days, settings).readyDate).toBe(`2026-01-0${days + 1}`)
  })
  it('считает календарные дни и рабочие переносы', () => {
    expect(scheduleDegassing('2026-01-01', 3, settings)).toMatchObject({ readyDate: '2026-01-04', plannedDate: '2026-01-05', actualDays: 4, decision: 'move' })
    expect(scheduleDegassing('2026-01-06', 5, settings)).toMatchObject({ plannedDate: '2026-01-12', actualDays: 6, decision: 'move' })
    expect(() => scheduleDegassing('2026-02-30', 3, settings)).toThrow('корректную дату')
    expect(() => scheduleDegassing('2026-01-01', 0, settings)).toThrow()
    expect(() => scheduleDegassing('2026-01-01', 6, settings)).toThrow()
  })
  it('создаёт Б/у при дегазации более 6 дней', () => {
    const longHoliday = { ...settings, nonWorkingDays: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'] }
    const result = scheduleDegassing('2026-01-01', 3, longHoliday)
    expect(result).toMatchObject({ decision: 'bu', buDate: '2026-01-02', plannedDate: '2026-01-12', actualDays: 11 })
  })
  it('учитывает ручное исправление', () => {
    expect(isWorkingDay('2026-01-03', settings)).toBe(false)
    expect(isWorkingDay('2026-01-03', { ...settings, workingOverrides: ['2026-01-03'] })).toBe(true)
  })
  it('загружает источник и сохраняет приоритет ручного исключения', () => {
    const calendarSource = parseCalendarSource({ nonWorkingDays: ['2026-11-18', '2026-11-18'], workingDays: ['2026-11-21'] })
    expect(calendarSource.nonWorkingDays).toEqual(['2026-11-18'])
    expect(isWorkingDay('2026-11-18', { ...settings, calendarSource })).toBe(false)
    expect(isWorkingDay('2026-11-21', { ...settings, calendarSource })).toBe(true)
    expect(isWorkingDay('2026-11-21', { ...settings, calendarSource, nonWorkingDays: ['2026-11-21'] })).toBe(false)
    expect(() => parseCalendarSource({ nonWorkingDays: ['2026-11-18'], workingDays: ['2026-11-18'] })).toThrow('одновременно')
    expect(isWorkingDay('2026-02-23', DEFAULT_SETTINGS)).toBe(false)
    expect(isWorkingDay('2026-12-31', DEFAULT_SETTINGS)).toBe(false)
  })
  it('находит рабочие даты по обе стороны длительной остановки', () => {
    const start = new Date(2026, 10, 17)
    const nonWorkingDays = Array.from({ length: 70 }, (_, offset) => dayKey(addDays(start, offset)))
    const closure = { ...settings, nonWorkingDays }
    expect(dayKey(nextWorkingDay(start, closure))).toBe('2027-01-26')
    expect(dayKey(previousWorkingDay('2027-01-26', closure))).toBe('2026-11-16')
  })
})

describe('наборы и резервы', () => {
  it('×6, ×16, ×30 и подписка используют лимитирующий лот', () => {
    expect(compositionCapacity([item('A', 6)], [stock('A', 25)]).maximum).toBe(4)
    expect(compositionCapacity([item('A', 4), item('B', 4), item('C', 4), item('D', 4)], [stock('A', 40), stock('B', 39), stock('C', 40), stock('D', 40)]).maximum).toBe(9)
    expect(compositionCapacity([item('A', 10), item('B', 10), item('C', 10)], [stock('A', 100), stock('B', 90), stock('C', 100)]).maximum).toBe(9)
    expect(compositionCapacity(Array.from({ length: 6 }, (_, i) => item(String(i), 5)), Array.from({ length: 6 }, (_, i) => stock(String(i), 50))).maximum).toBe(10)
  })
  it('вычитает резерв и блокирует несопоставленный лот', () => {
    const result = compositionCapacity([item('A', 6)], [stock('A', 100, 94)])
    expect(result.maximum).toBe(1)
    expect(compositionCapacity([item('X', 6)], [stock('A', 100)]).valid).toBe(false)
  })
})

describe('импорт', () => {
  it('читает CSV с кавычками и все колонки ×16', () => {
    const csv = 'Набор,"Первый, свежий",Второй\n' + [1, 2, 3, 4].map((i) => `Страна ${i} / локация ${i},Страна ${i} / Лот ${i},Страна ${i} / Другой ${i}`).join('\n')
    const parsed = parseCompositionSheet(csv, '×16', 'connection')
    expect(parsed).toHaveLength(2)
    expect(parsed[0].items).toHaveLength(4)
    expect(parsed[0].items.every((entry) => entry.quantityPerSet === 4)).toBe(true)
    expect(parsed[1].name).toBe('Второй')
  })
  it('не принимает пустой или повреждённый CSV', () => {
    expect(() => parseCsv('"не закрыто')).toThrow()
    expect(() => parseCompositionSheet('Набор,Один\nСтрана 1,Без слеша', '×16', 'c')).toThrow('найдено 1 строк')
  })
})
