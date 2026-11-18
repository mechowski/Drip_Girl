import { exactCoffeeKey, normalizeCoffeeName, uid } from '@/domain/calculations'
import type { CompositionItem, ImportedComposition } from '@/domain/types'

export interface PublicSheet {
  name: string
  gid: string
}

function parseSpreadsheetLink(value: string) {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Введите полную ссылку на Google Sheets')
  }
  const match = /^\/spreadsheets\/(?:u\/\d+\/)?d\/(e\/)?([\w-]+)(?:\/|$)/.exec(url.pathname)
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || !match) {
    throw new Error('Введите ссылку на таблицу docs.google.com')
  }
  return {
    id: match[2],
    published: Boolean(match[1]),
    base: `https://docs.google.com/spreadsheets/d/${match[1] ?? ''}${match[2]}`,
    gid: url.searchParams.get('gid') ?? new URLSearchParams(url.hash.slice(1)).get('gid'),
    single: url.searchParams.get('single') === 'true',
  }
}

export function spreadsheetId(url: string): string {
  return parseSpreadsheetLink(url).id
}

function decodeGoogleTitle(raw: string): string {
  return raw.replace(/\\(?:x([\da-f]{2})|u([\da-f]{4})|([\\'"nrt]))/gi, (_, hex: string, unicode: string, character: string) => {
    if (hex || unicode) return String.fromCharCode(Number.parseInt(hex || unicode, 16))
    return ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[character] ?? character
  })
}

export function parsePublicSheetList(html: string): PublicSheet[] {
  const sheets = new Map<string, string>()
  const pattern = /items\.push\(\{\s*name\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')[\s\S]*?\bgid\s*:\s*["']?(-?\d+)/g
  for (const [, doubleQuoted, singleQuoted, gid] of html.matchAll(pattern)) {
    sheets.set(gid, decodeGoogleTitle(doubleQuoted ?? singleQuoted))
  }
  if (!sheets.size && typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(html, 'text/html')
    for (const sheet of document.querySelectorAll('[id^="sheet-button-"], #sheet-menu a[href*="gid="]')) {
      const gid = /^sheet-button-(-?\d+)$/.exec(sheet.id)?.[1] ?? /\bgid=(-?\d+)/.exec(sheet.getAttribute('href') ?? '')?.[1]
      const name = sheet.textContent?.trim()
      if (gid && name) sheets.set(gid, name)
    }
  }
  return [...sheets].map(([gid, name]) => ({ name, gid }))
}

export async function listPublicSheets(url: string): Promise<PublicSheet[]> {
  const link = parseSpreadsheetLink(url)
  const suffix = link.published ? '/pubhtml' : '/htmlview'
  const query = link.single && link.gid ? `?gid=${encodeURIComponent(link.gid)}&single=true` : ''
  const response = await fetch(`${link.base}${suffix}${query}`, { credentials: 'omit', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Таблица недоступна (${response.status}). Откройте доступ по ссылке для чтения`)
  const list = parsePublicSheetList(await response.text())
  if (!list.length) throw new Error('Не удалось прочитать список листов. Проверьте, что таблица доступна без входа в Google')
  return list
}

export async function fetchSheetCsv(url: string, gid: string): Promise<string> {
  if (!/^-?\d+$/.test(gid)) throw new Error('Некорректный идентификатор листа')
  const link = parseSpreadsheetLink(url)
  const suffix = link.published ? '/pub?output=csv' : '/export?format=csv'
  const response = await fetch(`${link.base}${suffix}&gid=${gid}`, { credentials: 'omit', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Ошибка загрузки (${response.status})`)
  const text = await response.text()
  if (!text.trim()) throw new Error('Лист пуст')
  if (response.headers.get('content-type')?.includes('text/html') || /^\s*<(?:!doctype|html)\b/i.test(text)) {
    throw new Error('Google вернул страницу входа или ошибки вместо CSV. Проверьте доступ на чтение')
  }
  return text
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let afterQuote = false
  const pushCell = () => { row.push(cell.trim()); cell = ''; afterQuote = false }
  const pushRow = () => { pushCell(); if (row.some(Boolean)) rows.push(row); row = [] }

  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char !== '"') cell += char
      else if (text[index + 1] === '"') { cell += char; index++ }
      else { quoted = false; afterQuote = true }
    } else if (char === ',') pushCell()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      pushRow()
    } else if (char === '"') {
      if (afterQuote || cell.trim()) throw new Error('CSV содержит кавычку внутри некавыченного поля')
      quoted = true
    } else if (!afterQuote || !char.trim()) cell += char
    else throw new Error('CSV содержит текст после закрывающей кавычки поля')
  }
  if (quoted) throw new Error('CSV содержит незакрытую кавычку')
  pushRow()
  return rows
}

const lotLabel = /^(?:название\s+)?(страна|локация|лот(?:а)?)\s*(\d+)?(?:\s*[/–-]\s*(?:название\s+)?(?:страна|локация|лот(?:а)?)\s*(\d+)?)?$/
const titleLabel = /^(?:(?:название|наименование)\s+)?(?:набор(?:а)?|состав(?:а)?|название)$/
const quantityLabel = /^(?:количество(?:\s+(?:дрипов|пакетов))?|пакет(?:ов|ы)?|дрипов)\s*(?:на лот|(?:(?:лот|позиция)\s*)?\d+)$/

function groupLotRows(labels: string[]) {
  const groups = new Map<string, Array<{ index: number; label: string }>>()
  for (const [index, label] of labels.entries()) {
    const match = lotLabel.exec(label)
    if (!match) continue
    const number = match[2] ?? match[3]
    const key = number ? `lot-${number}` : `row-${index}`
    groups.set(key, [...(groups.get(key) ?? []), { index, label: match[1] }])
  }
  return [...groups.values()]
}

function parseLot(value: string, sheetName: string, column: number): { country: string; coffeeName: string } {
  const divider = value.indexOf('/')
  const country = value.slice(0, divider).trim()
  const coffeeName = value.slice(divider + 1).trim()
  if (divider < 0 || !country || !coffeeName) throw new Error(`Лист «${sheetName}», колонка ${column}: ожидается «Страна / название лота», получено «${value || 'пусто'}»`)
  return { country, coffeeName }
}

export function parseCompositionSheet(text: string, sheetName: string, connectionId: string, sheetGid?: string): ImportedComposition[] {
  let rows: string[][]
  try {
    rows = parseCsv(text)
  } catch (error) {
    throw new Error(`Лист «${sheetName}»: ${error instanceof Error ? error.message : 'ошибка CSV'}`)
  }
  const labels = rows.map((row) => normalizeCoffeeName(row[0] ?? ''))
  const lotGroups = groupLotRows(labels)
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  const columns = Array.from({ length: Math.max(0, width - 1) }, (_, index) => index + 1)
    .filter((column) => rows.some((row) => row[column]))
  if (!columns.length) throw new Error(`Лист «${sheetName}»: нет заполненных колонок`)
  const kindFromTitle = /(?:^|\D)30(?:\D|$)/.test(sheetName) ? 'x30' : /(?:^|\D)16(?:\D|$)/.test(sheetName) ? 'x16' : null
  const kind = kindFromTitle ?? (lotGroups.length === 4 ? 'x16' : lotGroups.length === 3 ? 'x30' : null)
  if (!kind) throw new Error(`Лист «${sheetName}», колонка ${columns[0] + 1}: для ×16 нужны четыре строки лотов, а для ×30 три`)
  const lotCount = kind === 'x16' ? 4 : 3
  const quantityPerSet = kind === 'x16' ? 4 : 10
  const lotRows = new Set(lotGroups.flatMap((group) => group.map(({ index }) => index)))
  const titleIndex = labels.findIndex((label) => titleLabel.test(label))
  const header = titleIndex >= 0 ? titleIndex : 0
  const names = new Set<string>()
  const compositions: ImportedComposition[] = []
  for (const column of columns) {
    const values = rows.map((row) => row[column]?.trim() ?? '')
    const at = `Лист «${sheetName}», колонка ${column + 1}`
    if (lotGroups.length !== lotCount) throw new Error(`${at}: найдено ${lotGroups.length} строк лотов вместо ${lotCount}`)
    const name = values[header]
    if (!name) throw new Error(`${at}: укажите название набора`)
    const nameKey = normalizeCoffeeName(name)
    if (names.has(nameKey)) throw new Error(`${at}: название набора «${name}» уже встречалось на листе`)
    names.add(nameKey)

    for (const [index, label] of labels.entries()) {
      if (quantityLabel.test(label) && values[index] && Number(values[index]) !== quantityPerSet) {
        throw new Error(`${at}, строка ${index + 1}: ожидается ${quantityPerSet} пакетов каждого лота`)
      }
    }
    const items: CompositionItem[] = lotGroups.map((group) => {
      const country = group.find(({ label }) => label === 'страна')
      const coffee = group.find(({ label }) => label !== 'страна')
      const value = group.length === 1 ? values[group[0].index]
        : group.length === 2 && country && coffee ? `${values[country.index]} / ${values[coffee.index]}` : ''
      return { id: uid(), ...parseLot(value, sheetName, column + 1), formatId: 'drip', quantityPerSet }
    })
    const coffeeKeys = items.map((item) => exactCoffeeKey(item.country, item.coffeeName))
    if (new Set(coffeeKeys).size !== items.length) throw new Error(`${at}: один и тот же лот указан несколько раз`)

    const metadata = Object.fromEntries(labels.flatMap((_, index) =>
      index !== header && !lotRows.has(index) && values[index] ? [[rows[index][0] || `Строка ${index + 1}`, values[index]]] : [],
    ))
    compositions.push({ id: uid(), sheetConnectionId: connectionId, sheetName, sheetGid, column: column + 1, name, kind, items, enabled: true, metadata, importedAt: new Date().toISOString() })
  }
  return compositions
}
