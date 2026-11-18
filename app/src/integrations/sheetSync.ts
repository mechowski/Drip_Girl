import type { SheetConnection } from '@/domain/types'
import { recordSheetImportFailure, saveImportedCompositions } from '@/persistence/compositions'
import { fetchSheetCsv, parseCompositionSheet, spreadsheetId, type PublicSheet } from './googleSheets'

export function sheetSelection(sheet: PublicSheet): string {
  return `${sheet.name}::${sheet.gid}`
}

export function selectedPublicSheets(connection: SheetConnection): PublicSheet[] {
  return connection.selectedSheets.flatMap((selection) => {
    const match = /^([\s\S]+)::(-?\d+)$/.exec(selection)
    return match ? [{ name: match[1], gid: match[2] }] : []
  })
}

export function currentSheetConnection(connections: SheetConnection[]): SheetConnection | undefined {
  return connections.filter((connection) => /^https?:\/\//.test(connection.url))
    .sort((left, right) => (right.lastSuccessAt ?? right.lastAttemptAt ?? '').localeCompare(left.lastSuccessAt ?? left.lastAttemptAt ?? ''))[0]
}

function sameSpreadsheet(left: string, right: string) {
  try {
    return spreadsheetId(left) === spreadsheetId(right)
  } catch {
    return false
  }
}

export async function refreshPublicSheets(connection: SheetConnection, expected: SheetConnection | null) {
  const sheets = selectedPublicSheets(connection)
  try {
    if (!sheets.length) throw new Error('Выберите хотя бы один лист')
    const snapshot = await Promise.all(sheets.map(async (sheet) => {
      let text: string
      try {
        text = await fetchSheetCsv(connection.url, sheet.gid)
      } catch (error) {
        const message = error instanceof TypeError ? 'не удалось загрузить CSV. Проверьте сеть и публичный доступ к таблице'
          : error instanceof Error ? error.message : 'не удалось загрузить CSV'
        throw new Error(`Лист «${sheet.name}»: ${message}`)
      }
      return parseCompositionSheet(text, sheet.name, connection.id, sheet.gid)
    }))
    const compositions = snapshot.flat()
    await saveImportedCompositions(connection.id, compositions, connection.selectedSheets, {
      connection, expected, replaceSource: Boolean(expected && !sameSpreadsheet(connection.url, expected.url)),
    })
    return compositions.length
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обновить составы'
    await recordSheetImportFailure(connection, expected, message)
    throw error
  }
}

const day = 24 * 60 * 60 * 1000
const hour = 60 * 60 * 1000

export function isSheetRefreshDue(connection: SheetConnection, time = Date.now()): boolean {
  if (!/^https:\/\/docs\.google\.com\//.test(connection.url) || !selectedPublicSheets(connection).length) return false
  const elapsed = (value?: string) => time - (value ? Date.parse(value) : 0)
  return elapsed(connection.lastSuccessAt) >= day && elapsed(connection.lastAttemptAt) >= hour
}
