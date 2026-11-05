import { describe, expect, it } from 'vitest'
import { buildProductionTasks, compositionCapacity, plannedOutput, remainingCoffee, validateAllocations } from '@/domain/calculations'
import { isWorkingDay, scheduleDegassing } from '@/domain/calendar'
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
    expect(validateAllocations(5, [{ weightKg: 0 }])).toContain('больше нуля')
  })
  it('объединяет обычные дрипы и разделяет форматы', () => {
    const lot = { id: 'lot', country: 'Эфиопия', name: 'Гуджи', roastDate: '2026-11-02', weightKg: 12, degassingDays: 3, createdAt: '2026-11-02' }
    const allocations = [
      { id: 'a', lotId: 'lot', formatId: 'drip' as const, purpose: '×6', weightKg: 5 },
      { id: 'b', lotId: 'lot', formatId: 'drip' as const, purpose: '×16', weightKg: 3 },
      { id: 'c', lotId: 'lot', formatId: 'mega' as const, purpose: 'Мега', weightKg: 2 },
      { id: 'd', lotId: 'lot', formatId: 'smol30' as const, purpose: '30 г', weightKg: 2 },
    ]
    const tasks = buildProductionTasks(lot, allocations, DEFAULT_SETTINGS, scheduleDegassing)
    expect(tasks).toHaveLength(3)
    expect(tasks.find((task) => task.formatId === 'drip')?.sourceWeightKg).toBe(8)
  })
  it('считает частичное изготовление и списание без отрицательного остатка', () => {
    const format = DEFAULT_SETTINGS.formats[0]
    expect(remainingCoffee({ sourceWeightKg: 12.1, producedQuantity: 600, writtenOffKg: 0 }, format)).toBeCloseTo(4.84)
    expect(remainingCoffee({ sourceWeightKg: 1, producedQuantity: 100, writtenOffKg: 0 }, format)).toBe(0)
  })
})

describe('календарь', () => {
  const settings = { ...DEFAULT_SETTINGS, nonWorkingDays: ['2026-01-01', '2026-01-02'], workingOverrides: [] }
  it('считает календарные дни и рабочие переносы', () => {
    expect(scheduleDegassing('2026-01-01', 3, settings)).toMatchObject({ readyDate: '2026-01-04', plannedDate: '2026-01-05', actualDays: 4, decision: 'move' })
    expect(() => scheduleDegassing('2026-01-01', 6, settings)).toThrow()
  })
  it('создаёт Б/у при дегазации более 6 дней', () => {
    const longHoliday = { ...settings, nonWorkingDays: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'] }
    const result = scheduleDegassing('2026-01-01', 3, longHoliday)
    expect(result.decision).toBe('bu')
    expect(result.plannedDate).toBe('2026-01-02')
  })
  it('учитывает ручное исправление', () => {
    expect(isWorkingDay('2026-01-03', settings)).toBe(false)
    expect(isWorkingDay('2026-01-03', { ...settings, workingOverrides: ['2026-01-03'] })).toBe(true)
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
