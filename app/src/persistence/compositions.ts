import { coffeeKey, exactCoffeeKey, matchComposition, strictCoffeeName, uid } from '@/domain/calculations'
import { resolveCoffeeAlias, singleLotSetName, validateImportedComposition, validateManualComposition } from '@/domain/compositions'
import type { CompositionItem, ImportedComposition, InventoryLot, ManualComposition, SheetConnection } from '@/domain/types'
import { db } from './db'

const now = () => new Date().toISOString()

async function manualFields(name: string, kind: ManualComposition['kind'], items: CompositionItem[]) {
  const sourceId = items[0]?.inventoryLotId
  const source = singleLotSetName(kind, items[0]) !== undefined && sourceId ? await db.lots.get(sourceId) : undefined
  const ingredients = source ? [{ ...items[0], country: source.country, coffeeName: source.name }, ...items.slice(1)] : items
  const title = singleLotSetName(kind, ingredients[0]) ?? name.trim()
  validateManualComposition(title, kind, ingredients)
  return { name: title, kind, items: ingredients }
}

export async function addManualComposition(name: string, kind: ManualComposition['kind'], items: CompositionItem[], isDemo = false) {
  await db.transaction('rw', db.lots, db.manualCompositions, async () => {
    const fields = await manualFields(name, kind, items)
    await db.manualCompositions.add({ ...fields, id: uid(), enabled: true, createdAt: now(), isDemo })
  })
}

export async function updateManualComposition(id: string, name: string, kind: ManualComposition['kind'], items: CompositionItem[]) {
  await db.transaction('rw', db.lots, db.manualCompositions, async () => {
    const fields = await manualFields(name, kind, items)
    const updated = await db.manualCompositions.update(id, fields)
    if (!updated) throw new Error('Состав не найден')
  })
}

export async function updateImportedComposition(id: string, name: string, items: CompositionItem[]) {
  await db.transaction('rw', [db.importedCompositions, db.warnings, db.inventory], async () => {
    const composition = await db.importedCompositions.get(id)
    if (!composition || composition.removed) throw new Error('Состав не найден')
    validateImportedComposition(name, composition.kind, items)
    const updated = { ...composition, sourceName: composition.sourceName ?? composition.name, name: name.trim(), items }
    await db.importedCompositions.put(updated)
    await syncMatchingWarnings([updated], await db.inventory.toArray())
  })
}

export async function deleteComposition(id: string, imported: boolean) {
  await db.transaction('rw', [db.manualCompositions, db.importedCompositions, db.warnings], async () => {
    if (imported) {
      const composition = await db.importedCompositions.get(id)
      if (!composition || composition.removed) throw new Error('Состав не найден')
      // Keep the source key so a refresh does not re-add a deleted imported composition.
      await db.importedCompositions.update(id, { removed: true, enabled: false })
    } else {
      if (!(await db.manualCompositions.get(id))) throw new Error('Состав не найден')
      await db.manualCompositions.delete(id)
    }
    await db.warnings.filter((item) => item.compositionId === id && !item.read).modify({ read: true })
  })
}

export async function toggleComposition(id: string, imported: boolean) {
  const table = imported ? db.importedCompositions : db.manualCompositions
  await db.transaction('rw', table, async () => {
    const composition = await table.get(id)
    if (!composition || ('removed' in composition && composition.removed)) throw new Error('Состав не найден')
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
      const previous = options.replaceSource ? undefined : old.find((item) => unused.has(item.id) && sameSheet(item, composition) && strictCoffeeName(item.sourceName ?? item.name) === strictCoffeeName(composition.name))
      if (previous) unused.delete(previous.id)
      if (previous?.removed) return previous
      const items = composition.items.map((item) => ({
        ...item,
        id: previous?.items.find((entry) => exactCoffeeKey(entry.country, entry.coffeeName) === exactCoffeeKey(item.country, item.coffeeName))?.id ?? item.id,
        inventoryLotId: resolveCoffeeAlias(item, aliases) ?? item.inventoryLotId,
      }))
      return {
        ...composition, id: previous?.id ?? composition.id, importedAt, enabled: previous?.enabled ?? composition.enabled,
        ...(previous?.sourceName ? { sourceName: composition.name, name: previous.name, items: previous.items } : { items }),
      }
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
    await syncMatchingWarnings(merged.filter((item) => !item.removed), await db.inventory.toArray())
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
    const changed = (await db.importedCompositions.toArray()).filter((composition) => !composition.removed && composition.items.some((item) => coffeeKey(item.country, item.coffeeName) === folded))
      .map((composition) => ({ ...composition, items: composition.items.map((item) => {
        if (coffeeKey(item.country, item.coffeeName) !== folded || (composition.sourceName && item.inventoryLotId)) return item
        return { ...item, inventoryLotId: resolveCoffeeAlias(item, updatedAliases) }
      }) }))
    await db.importedCompositions.bulkPut(changed)
    await syncMatchingWarnings(changed, await db.inventory.toArray())
  })
}
