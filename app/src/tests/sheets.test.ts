import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compositionCapacity } from '@/domain/calculations'
import { resolveCoffeeAlias, validateManualComposition } from '@/domain/compositions'
import type { AssemblyTask, CoffeeAlias, CompositionItem, InventoryLot, SheetConnection } from '@/domain/types'
import { listPublicSheets, parseCompositionSheet, parsePublicSheetList, spreadsheetId } from '@/integrations/googleSheets'
import { isSheetRefreshDue, refreshPublicSheets } from '@/integrations/sheetSync'
import { addManualComposition, deleteComposition, saveAlias, toggleComposition, updateImportedComposition, updateManualComposition } from '@/persistence/compositions'
import { db } from '@/persistence/db'

const url = 'https://docs.google.com/spreadsheets/d/test_document/edit#gid=1'
const standardSheets: SheetConnection = { id: 'connection', url, selectedSheets: ['×16::1', '×30::2'] }
const csv = (count: number, names = ['Утренний', 'Вечерний'], change?: string) => {
  const header = `Набор,${names.join(',')}`
  const lotRows = Array.from({ length: count }, (_, index) => {
    const number = index + 1
    return `Страна ${number} / локация ${number},${names.map((_, column) => `Страна ${column + 1} / ${index === 0 && change ? change : `Лот ${number}`}`).join(',')}`
  })
  return [header, ...lotRows].join('\n')
}

function coffee(name: string, quantityPerSet: number, formatId: CompositionItem['formatId'] = 'drip'): CompositionItem {
  return { id: name, country: 'Страна', coffeeName: name, formatId, quantityPerSet, inventoryLotId: name }
}

function stock(item: CompositionItem, quantity: number, reserved = 0): InventoryLot {
  return { id: item.id, sourceLotId: item.id, productionTaskId: 'task', country: item.country, coffeeName: item.coffeeName, formatId: item.formatId, purpose: '×6', quantity, reserved, manufacturedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', inBU: false }
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear()
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('Чтение опубликованных листов и структур CSV', () => {
  it('извлекает все видимые листы и декодирует названия без выполнения скрипта Google', async () => {
    const html = String.raw`items.push({name: "Дрипы \u00d716", pageUrl: "https:\/\/docs.google.com\/", gid: "1"});items.push({name: "Состав \x2230\x22", pageUrl: "", gid: "2"});`
    expect(parsePublicSheetList(html)).toEqual([{ name: 'Дрипы ×16', gid: '1' }, { name: 'Состав "30"', gid: '2' }])
    const fetch = vi.fn(async () => new Response(html))
    vi.stubGlobal('fetch', fetch)
    await expect(listPublicSheets(url)).resolves.toHaveLength(2)
    expect(fetch).toHaveBeenCalledWith('https://docs.google.com/spreadsheets/d/test_document/htmlview', expect.objectContaining({ credentials: 'omit' }))
    expect(spreadsheetId('https://docs.google.com/spreadsheets/d/e/pub-ID/pubhtml')).toBe('pub-ID')
    expect(() => spreadsheetId('https://other.example/spreadsheets/d/test')).toThrow('docs.google.com')
  })

  it('находит имена и лоты по заголовкам, сохраняет метаданные, обрабатывает все колонки', () => {
    const text = '\ufeffОтчёт,Ноябрь,Ноябрь\r\nНаименование набора,Первый,Второй\r\n' +
      'Страна 1,Эфиопия,Колумбия\r\nНазвание лота 1,Гуджи,Уила\r\n' +
      'Страна 2 / локация 2,Кения / Ньери,Уганда / Капчорва\r\n' +
      'Вкусовые ноты,"яблоко, какао",черника\r\nЛот 3,Перу / Кахамарка,Бразилия / Серрадо\r\nПакетов на лот,10,10'
    const result = parseCompositionSheet(text, 'Сезонные ×30', 'id', '9')
    expect(result.map((item) => item.name)).toEqual(['Первый', 'Второй'])
    expect(result[0].items.map(({ coffeeName, quantityPerSet }) => [coffeeName, quantityPerSet])).toEqual([['Гуджи', 10], ['Ньери', 10], ['Кахамарка', 10]])
    expect(result[0]).toMatchObject({ sheetGid: '9', column: 2, metadata: { Отчёт: 'Ноябрь', 'Вкусовые ноты': 'яблоко, какао' } })
  })

  it('показывает лист и колонку, если состав пустой, неполный или повторяется', () => {
    expect(() => parseCompositionSheet(csv(4, ['Утро', ' утро ']), '×16', 'id')).toThrow('колонка 3')
    expect(() => parseCompositionSheet(csv(4).replace('Страна 2 / Лот 4', ''), '×16', 'id')).toThrow('колонка 3')
    expect(() => parseCompositionSheet(csv(4).replace('Страна 1 / Лот 4', 'Страна 1 / Лот 3'), '×16', 'id')).toThrow('указан несколько раз')
    expect(() => parseCompositionSheet(csv(3) + '\nПакетов 1,9,10', '×30', 'id')).toThrow('10 пакетов')
    expect(() => parseCompositionSheet(csv(2), 'Неизвестный лист', 'id')).toThrow('Неизвестный лист')
    expect(parseCompositionSheet(csv(4), 'Коллекция', 'id')[0].kind).toBe('x16')
  })
})

describe('Импорт, последняя рабочая версия и локальные псевдонимы', () => {
  it('обновляет несколько листов атомарно, сохраняет выключенные составы и снимок задания', async () => {
    let first = csv(4)
    let second = csv(3)
    let offline = false
    vi.stubGlobal('fetch', vi.fn(async (endpoint: string) => {
      if (offline) throw new TypeError('Failed to fetch')
      return new Response(endpoint.endsWith('gid=1') ? first : second, { headers: { 'content-type': 'text/csv' } })
    }))
    await expect(refreshPublicSheets(standardSheets, null)).resolves.toBe(4)
    const initial = (await db.importedCompositions.toArray()).find((item) => item.kind === 'x16' && item.name === 'Утренний')!
    await toggleComposition(initial.id, true)
    const task: AssemblyTask = { id: 'assembly-task', planId: 'plan', compositionId: initial.id, compositionKind: initial.kind, compositionSnapshot: initial.items, name: initial.name, plannedQuantity: 5, completedQuantity: 0, status: 'confirmed', productionDate: '2026-11-18', createdAt: '2026-11-18T00:00:00Z' }
    await db.assemblyTasks.add(task)
    const expected = (await db.sheetConnections.get(standardSheets.id))!
    const known = await db.importedCompositions.toArray()
    first = csv(4, ['Вечерний', 'Утренний'], 'Обновлённый лот')
    second = csv(2)
    await expect(refreshPublicSheets(expected, expected)).rejects.toThrow('Лист «×30»')
    expect(await db.importedCompositions.toArray()).toEqual(known)
    expect(await db.sheetConnections.get(standardSheets.id)).toMatchObject({ lastSuccessAt: expected.lastSuccessAt, lastError: expect.stringContaining('×30') })
    offline = true
    await expect(refreshPublicSheets(expected, expected)).rejects.toThrow('Проверьте сеть')
    expect(await db.importedCompositions.toArray()).toEqual(known)
    expect(await db.warnings.where('type').equals('import').count()).toBe(2)
    offline = false
    second = csv(3)
    await expect(refreshPublicSheets(expected, expected)).resolves.toBe(4)
    const updated = await db.importedCompositions.get(initial.id)
    expect(updated).toMatchObject({ column: 3, enabled: false, items: [expect.objectContaining({ coffeeName: 'Обновлённый лот' }), ...Array(3).fill(expect.any(Object))] })
    expect(await db.assemblyTasks.get(task.id)).toEqual(task)
    expect((await db.sheetConnections.get(expected.id))?.lastError).toBeUndefined()
  })

  it('сохраняет локальные правки и удаление состава после обновления таблицы', async () => {
    const connection = { ...standardSheets, selectedSheets: ['×16::1'] }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(csv(4))))
    await refreshPublicSheets(connection, null)
    const [edited, removed] = await db.importedCompositions.orderBy('id').toArray()
    const items = edited.items.map((item, index) => index === 0 ? { ...item, coffeeName: 'Правильный лот' } : item)
    await updateImportedComposition(edited.id, 'Правильный состав', items)
    await deleteComposition(removed.id, true)
    const expected = (await db.sheetConnections.get(connection.id))!
    await refreshPublicSheets(expected, expected)
    expect(await db.importedCompositions.get(edited.id)).toMatchObject({ name: 'Правильный состав', items })
    expect(await db.importedCompositions.get(removed.id)).toMatchObject({ removed: true, enabled: false })
    expect(await db.importedCompositions.count()).toBe(2)
  })

  it('блокирует только несопоставленный состав и повторно применяет сохранённый псевдоним', async () => {
    const connection = { ...standardSheets, selectedSheets: ['×16::1'] }
    const changed = csv(4).replace('Страна 1 / Лот 1', 'Имя из импорта / Нужна замена')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(changed)))
    for (const [column, index] of [[1, 2], [1, 3], [1, 4], [2, 1], [2, 2], [2, 3], [2, 4], [3, 1]]) {
      const country = `Страна ${column}`
      const name = `Лот ${index}`
      const source = `source-${column}-${index}`
      await db.lots.add({ id: source, country, name, roastDate: '2026-11-01', weightKg: 1, degassingDays: 3, createdAt: '2026-11-01' })
      await db.inventory.add(stock({ id: source, country, coffeeName: name, formatId: 'drip', quantityPerSet: 4 }, 32))
    }
    await refreshPublicSheets(connection, null)
    const compositions = await db.importedCompositions.toArray()
    const missing = compositions.find((entry) => entry.name === 'Утренний')!
    const valid = compositions.find((entry) => entry.name === 'Вечерний')!
    const inventory = await db.inventory.toArray()
    expect(compositionCapacity(missing.items, inventory).maximum).toBe(0)
    expect(compositionCapacity(valid.items, inventory).maximum).toBe(8)
    expect(await db.warnings.where('type').equals('unmatched').first()).toMatchObject({ compositionId: missing.id, read: false })
    await saveAlias('  имя из импорта ', 'НУЖНА  ЗАМЕНА', 'source-3-1')
    const expected = (await db.sheetConnections.get(connection.id))!
    await refreshPublicSheets(expected, expected)
    const after = (await db.importedCompositions.get(missing.id))!
    expect(after.items[0].inventoryLotId).toBe('source-3-1')
    expect(compositionCapacity(after.items, inventory).maximum).toBe(8)
    expect(await db.warnings.where('type').equals('unmatched').first()).toMatchObject({ read: true })
  })

  it('отклоняет устаревшее обновление, если другая вкладка уже сохранила снимок', async () => {
    const connection = { ...standardSheets, selectedSheets: ['×16::1'] }
    let contents = csv(4)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(contents)))
    await refreshPublicSheets(connection, null)
    const expected = (await db.sheetConnections.get(connection.id))!
    contents = csv(4, ['Актуальный', 'Вечерний'])
    await refreshPublicSheets(expected, expected)
    contents = csv(4, ['Устаревший', 'Вечерний'])
    await expect(refreshPublicSheets(expected, expected)).rejects.toThrow('Настройки таблицы изменились')
    expect((await db.importedCompositions.toArray()).map(({ name }) => name)).toContain('Актуальный')
    expect((await db.sheetConnections.get(connection.id))?.lastError).toBeUndefined()
  })

  it('считает срок обновления от успешного импорта и ограничивает повторы после ошибки', () => {
    const moment = Date.parse('2026-11-18T12:00:00Z')
    expect(isSheetRefreshDue({ ...standardSheets, lastSuccessAt: '2026-11-17T12:00:00Z' }, moment)).toBe(true)
    expect(isSheetRefreshDue({ ...standardSheets, lastSuccessAt: '2026-11-17T13:00:00Z' }, moment)).toBe(false)
    expect(isSheetRefreshDue({ ...standardSheets, lastAttemptAt: '2026-11-18T11:01:00Z' }, moment)).toBe(false)
    expect(isSheetRefreshDue({ ...standardSheets, url: 'Локальный CSV' }, moment)).toBe(false)
  })

  it('даёт приоритет точной записи псевдонима при конфликтующей нормализации ё/е', () => {
    const aliases: CoffeeAlias[] = [
      { id: '1', importedCountry: 'Страна', importedName: 'Ёлка', inventoryLotId: 'first', createdAt: '2026-11-18' },
      { id: '2', importedCountry: 'Страна', importedName: 'Елка', inventoryLotId: 'second', createdAt: '2026-11-18' },
    ]
    expect(resolveCoffeeAlias(coffee('Ёлка', 4), aliases)).toBe('first')
    expect(resolveCoffeeAlias(coffee(' елка ', 4), aliases)).toBe('second')
    expect(resolveCoffeeAlias(coffee(' елка ', 4), aliases.slice(0, 1))).toBe('first')
  })
})

describe('Ручные составы', () => {
  it('поддерживает ×6, Мега ×6, подписку и смешанную лимитку', () => {
    const drip = coffee('Дрип', 6)
    const mega = coffee('Мега', 6, 'mega')
    expect(() => validateManualComposition('Дрип', 'x6', [drip])).not.toThrow()
    expect(() => validateManualComposition('Мега', 'mega6', [mega])).not.toThrow()
    expect(() => validateManualComposition('Мега', 'mega6', [drip])).toThrow('пакетов Мега')
    const subscription = Array.from({ length: 6 }, (_, index) => coffee(String(index), 5))
    expect(() => validateManualComposition('Подписка', 'subscription', subscription)).not.toThrow()
    expect(() => validateManualComposition('Подписка', 'subscription', Array(6).fill(subscription[0]))).toThrow('разных лотов')
    expect(compositionCapacity([mega], [stock(mega, 24, 6)]).maximum).toBe(3)
    expect(compositionCapacity([drip, mega], [stock(drip, 12), stock(mega, 90)]).maximum).toBe(2)
    expect(() => validateManualComposition('СМОЛ', 'limit', [coffee('СМОЛ', 1, 'smol30')])).toThrow('обычные дрипы и Мега')
  })

  it('сохраняет точное название исходного лота для ×6 и Мега ×6', async () => {
    const source = { ...coffee('Перископ Мармелада', 6), country: 'Бразилия', inventoryLotId: undefined }
    await addManualComposition('Ручное имя', 'x6', [source])
    await addManualComposition('Ручное имя Мега', 'mega6', [{ ...source, formatId: 'mega' }])
    const compositions = await db.manualCompositions.toArray()
    expect(compositions.map(({ name }) => name)).toEqual(['Бразилия Перископ Мармелада х6', 'Бразилия Перископ Мармелада х6'])
    await deleteComposition(compositions[0].id, false)
    expect(await db.manualCompositions.count()).toBe(1)
  })

  it('сохраняет ID и состояние при редактировании ручной лимитки', async () => {
    await addManualComposition('Лимита', 'limit', [coffee('Лот', 1)])
    const [initial] = await db.manualCompositions.toArray()
    await toggleComposition(initial.id, false)
    await updateManualComposition(initial.id, 'Новая лимита', 'limit', [coffee('Лот', 2)])
    expect(await db.manualCompositions.toArray()).toEqual([{ ...initial, name: 'Новая лимита', enabled: false, items: [coffee('Лот', 2)] }])
  })
})
