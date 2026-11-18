import { coffeeKey, exactCoffeeKey, matchComposition, strictCoffeeName, uid } from '@/domain/calculations'
import { resolveCoffeeAlias, validateManualComposition } from '@/domain/compositions'
import type { CompositionItem, ImportedComposition, InventoryLot, ManualComposition, SheetConnection } from '@/domain/types'
import { db } from './db'

const now = () => new Date().toISOString()

export async function addManualComposition(name: string, kind: ManualComposition['kind'], items: CompositionItem[], isDemo = false) {
  validateManualComposition(name, kind, items)
  await db.manualCompositions.add({ id: uid(), name: name.trim(), kind, items, enabled: true, createdAt: now(), isDemo })
}

export async function updateManualComposition(id: string, name: string, kind: ManualComposition['kind'], items: CompositionItem[]) {
  validateManualComposition(name, kind, items)
  const updated = await db.manualCompositions.update(id, { name: name.trim(), kind, items })
  if (!updated) throw new Error('Состав не найден')
}

export async function toggleComposition(id: string, imported: boolean) {
  const table = imported ? db.importedCompositions : db.manualCompositions
  await db.transaction('rw', table, async () => {
    const composition = await table.get(id)
    if (!composition) throw new Error('Состав не найден')
    await table.update(id, { enabled: !composition.enabled })
  })
}

async function syncMatchingWarnings(compositions: ImportedComposition[], inventory: InventoryLot[]) {
  const warnings = await db.warnings.where('type').equals('unmatched').toArray()
  for (const composition of compositions) {
    const messages = new Set(matchComposition(composition.items, inventory)
      .filter((match) => match.ambiguous || (!match.matched && !match.item.inventoryLotId))
      .map(({ item }) => `«${composition.name}»: сопоставьте ${item.country} / ${item.coffeeName}`))
    const previous = warnings.filter((warning) => warning.compositionId === composition.id)
    for (const warning of previous) {
      if (!messages.has(warning.message) && !warning.read) await db.warnings.update(warning.id, { read: true })
    }
    for (const message of messages) {
      if (!previous.some((warning) => warning.message === message)) {
        await db.warnings.add({ id: uid(), type: 'unmatched', compositionId: composition.id, message, read: false, createdAt: now() })
      }
    }
  }
}

interface SaveOptions {
  connection?: SheetConnection
  expected?: SheetConnection | null
  replaceSource?: boolean
  retainOtherSheets?: boolean
}

function unchangedConnection(current: SheetConnection | undefined, expected: SheetConnection | null | undefined) {
  if (expected === undefined) return true
  if (!expected) return !current
  return current?.url === expected.url && current.lastSnapshotId === expected.lastSnapshotId && current.lastSuccessAt === expected.lastSuccessAt
    && current.selectedSheets.join('\n') === expected.selectedSheets.join('\n')
}

const isPublicConnection = (connection: SheetConnection) => /^https?:\/\//.test(connection.url)

async function sourceAlreadyConfigured(connection: SheetConnection): Promise<boolean> {
  return Boolean(await db.sheetConnections.filter((entry) => isPublicConnection(entry) === isPublicConnection(connection)).first())
}

function sameSheet(left: ImportedComposition, right: ImportedComposition) {
  return left.sheetGid && right.sheetGid ? left.sheetGid === right.sheetGid : left.sheetName === right.sheetName
}

export async function saveImportedCompositions(connectionId: string, compositions: ImportedComposition[], sheetNames: string[], options: SaveOptions = {}) {
  if (!compositions.length) throw new Error('Импорт не содержит корректных составов; прежние данные сохранены')
  await db.transaction('rw', [db.sheetConnections, db.importedCompositions, db.aliases, db.inventory, db.warnings], async () => {
    const current = await db.sheetConnections.get(connectionId)
    if (!unchangedConnection(current, options.expected)) throw new Error('Настройки таблицы изменились во время импорта. Повторите обновление')
    const connection = options.connection ?? current
    if (!connection) throw new Error('Сначала подключите таблицу')
    if (options.expected === null && await sourceAlreadyConfigured(connection)) {
      throw new Error('Источник настроен в другой вкладке. Повторите обновление')
    }
    const old = await db.importedCompositions.where('sheetConnectionId').equals(connectionId).toArray()
    const aliases = await db.aliases.toArray()
    const unused = new Set(old.map((composition) => composition.id))
    const importedAt = now()
    const merged = compositions.map((composition) => {
      const previous = options.replaceSource ? undefined : old.find((item) => unused.has(item.id) && sameSheet(item, composition) && strictCoffeeName(item.name) === strictCoffeeName(composition.name))
      if (previous) unused.delete(previous.id)
      const items = composition.items.map((item) => ({
        ...item,
        id: previous?.items.find((entry) => exactCoffeeKey(entry.country, entry.coffeeName) === exactCoffeeKey(item.country, item.coffeeName))?.id ?? item.id,
        inventoryLotId: resolveCoffeeAlias(item, aliases) ?? item.inventoryLotId,
      }))
      return { ...composition, id: previous?.id ?? composition.id, items, enabled: previous?.enabled ?? composition.enabled, importedAt }
    })
    const removed = old.filter((item) => unused.has(item.id) && (!options.retainOtherSheets || compositions.some((composition) => sameSheet(item, composition))))
    await db.importedCompositions.bulkDelete(removed.map((item) => item.id))
    await db.importedCompositions.bulkPut(merged)
    const removedIds = new Set(removed.map((item) => item.id))
    if (removedIds.size) {
      await db.warnings.where('type').equals('unmatched')
        .filter((warning) => Boolean(warning.compositionId && removedIds.has(warning.compositionId)) && !warning.read)
        .modify({ read: true })
    }
    const selectedSheets = options.retainOtherSheets ? [...new Set([...(current?.selectedSheets ?? []), ...sheetNames])] : sheetNames
    await db.sheetConnections.put({ ...connection, selectedSheets, lastSuccessAt: importedAt, lastSnapshotId: uid(), lastAttemptAt: importedAt, lastError: undefined })
    await syncMatchingWarnings(merged, await db.inventory.toArray())
  })
}

export async function recordSheetImportFailure(connection: SheetConnection, expected: SheetConnection | null, message: string) {
  await db.transaction('rw', [db.sheetConnections, db.warnings], async () => {
    const current = await db.sheetConnections.get(connection.id)
    if (!unchangedConnection(current, expected)) return
    const createdAt = now()
    if ((!current && !(await sourceAlreadyConfigured(connection))) || current?.url === connection.url) {
      await db.sheetConnections.put({ ...(current ?? connection), lastError: message, lastAttemptAt: createdAt })
    }
    const warning = `Google Sheets: ${message}`
    const exists = await db.warnings.where('type').equals('import').filter((item) => !item.read && item.message === warning).first()
    if (!exists) await db.warnings.add({ id: uid(), type: 'import', message: warning, read: false, createdAt })
  })
}

export async function saveAlias(importedCountry: string, importedName: string, sourceLotId: string) {
  if (!importedCountry.trim() || !importedName.trim()) throw new Error('Укажите страну и название импортированного лота')
  await db.transaction('rw', [db.aliases, db.lots, db.importedCompositions, db.inventory, db.warnings], async () => {
    if (!(await db.lots.get(sourceLotId))) throw new Error('Стоковый лот не найден')
    const aliases = await db.aliases.toArray()
    const exact = exactCoffeeKey(importedCountry, importedName)
    const existing = aliases.filter((alias) => exactCoffeeKey(alias.importedCountry, alias.importedName) === exact)
    const alias = { id: existing[0]?.id ?? uid(), importedCountry, importedName, inventoryLotId: sourceLotId, createdAt: existing[0]?.createdAt ?? now() }
    await db.aliases.put(alias)
    await db.aliases.bulkDelete(existing.slice(1).map((item) => item.id))
    const updatedAliases = [...aliases.filter((item) => !existing.some(({ id }) => id === item.id)), alias]
    const folded = coffeeKey(importedCountry, importedName)
    const changed = (await db.importedCompositions.toArray()).filter((composition) => composition.items.some((item) => coffeeKey(item.country, item.coffeeName) === folded))
      .map((composition) => ({ ...composition, items: composition.items.map((item) => {
        if (coffeeKey(item.country, item.coffeeName) !== folded) return item
        return { ...item, inventoryLotId: resolveCoffeeAlias(item, updatedAliases) }
      }) }))
    await db.importedCompositions.bulkPut(changed)
    await syncMatchingWarnings(changed, await db.inventory.toArray())
  })
}
