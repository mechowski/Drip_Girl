import { uid } from '@/domain/calculations'
import type { CompositionItem, ImportedComposition } from '@/domain/types'

export function spreadsheetId(url: string): string {
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/)
  if (!match) throw new Error('Нужна ссылка на Google Sheets вида …/d/ID/…')
  return match[1]
}

export async function listPublicSheets(url: string): Promise<Array<{ name: string; gid: string }>> {
  const id = spreadsheetId(url)
  const response = await fetch(`https://docs.google.com/spreadsheets/d/${id}/htmlview`)
  if (!response.ok) throw new Error('Таблица недоступна. Откройте доступ по ссылке для чтения')
  const html = await response.text()
  const sheets = new Map<string, string>()
  const pattern = /name\s*:\s*["']([^"']+)["'][\s\S]{0,250}?gid\s*:\s*["']?(\d+)/g
  for (const match of html.matchAll(pattern)) sheets.set(match[2], match[1])
  if (!sheets.size) {
    const gid = url.match(/gid=(\d+)/)?.[1] ?? '0'
    sheets.set(gid, 'Основной лист')
  }
  return [...sheets].map(([gid, name]) => ({ name, gid }))
}

export async function fetchSheetCsv(url: string, gid: string): Promise<string> {
  const id = spreadsheetId(url)
  const response = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`)
  if (!response.ok) throw new Error(`Лист ${gid}: ошибка загрузки (${response.status})`)
  const text = await response.text()
  if (!text.trim()) throw new Error(`Лист ${gid} пуст`)
  return text
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1 } else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(cell.trim()); cell = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell.trim()); cell = ''
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else cell += char
  }
  if (quoted) throw new Error('CSV содержит незакрытую кавычку')
  row.push(cell.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

const norm = (value: string) => value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()

function parseLot(value: string, sheetName: string, column: number): { country: string; coffeeName: string } {
  const parts = value.split('/').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) throw new Error(`Лист «${sheetName}», колонка ${column}: ожидается «Страна / название лота», получено «${value || 'пусто'}»`)
  return { country: parts[0], coffeeName: parts.slice(1).join(' / ') }
}

export function parseCompositionSheet(text: string, sheetName: string, connectionId: string): ImportedComposition[] {
  const rows = parseCsv(text)
  if (rows.length < 2 || rows[0].length < 2) throw new Error(`Лист «${sheetName}»: не найдены колонки составов`)
  const kind = sheetName.includes('30') ? 'x30' : sheetName.includes('16') ? 'x16' : null
  if (!kind) throw new Error(`Лист «${sheetName}»: название должно содержать ×16 или ×30`)
  const lotCount = kind === 'x16' ? 4 : 3
  const defaultQuantity = kind === 'x16' ? 4 : 10
  const labelRows = rows.map((row, index) => ({ index, label: norm(row[0] ?? '') }))
  const compositions: ImportedComposition[] = []
  const width = Math.max(...rows.map((row) => row.length))
  for (let column = 1; column < width; column += 1) {
    const values = rows.map((row) => row[column]?.trim() ?? '')
    if (!values.some(Boolean)) continue
    const lotRows = labelRows.filter(({ label }) => /страна|локация|лот/.test(label) && !/количество|пакет/.test(label))
    if (lotRows.length < lotCount) throw new Error(`Лист «${sheetName}», колонка ${column + 1}: найдено ${lotRows.length} строк лотов вместо ${lotCount}`)
    const name = values[0] || `${sheetName}, состав ${column}`
    const items: CompositionItem[] = lotRows.slice(0, lotCount).map(({ index }) => {
      const lot = parseLot(values[index], sheetName, column + 1)
      const quantityRow = labelRows.find(({ label }) => /количество|пакет/.test(label) && new RegExp(`(?:^|\\D)${index + 1}(?:\\D|$)`).test(label))
      const parsed = quantityRow ? Number(values[quantityRow.index].replace(',', '.')) : defaultQuantity
      return { id: uid(), ...lot, formatId: 'drip', quantityPerSet: Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultQuantity }
    })
    const usedRows = new Set(lotRows.slice(0, lotCount).map((item) => item.index))
    const metadata: Record<string, string> = {}
    labelRows.forEach(({ index }) => {
      if (index > 0 && !usedRows.has(index) && values[index]) metadata[rows[index][0] || `Строка ${index + 1}`] = values[index]
    })
    compositions.push({ id: uid(), sheetConnectionId: connectionId, sheetName, column: column + 1, name, kind, items, enabled: true, metadata, importedAt: new Date().toISOString() })
  }
  if (!compositions.length) throw new Error(`Лист «${sheetName}»: нет заполненных колонок`)
  return compositions
}
