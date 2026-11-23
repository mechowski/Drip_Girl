import { coffeeKey, exactCoffeeKey, validateCompositionItems } from './calculations'
import type { CoffeeAlias, CompositionItem, ImportedComposition, ManualComposition } from './types'

export function resolveCoffeeAlias(item: CompositionItem, aliases: CoffeeAlias[]): string | undefined {
  const exact = exactCoffeeKey(item.country, item.coffeeName)
  const exactMatches = aliases.filter((alias) => exactCoffeeKey(alias.importedCountry, alias.importedName) === exact)
  const folded = coffeeKey(item.country, item.coffeeName)
  const matches = exactMatches.length ? exactMatches : aliases.filter((alias) => coffeeKey(alias.importedCountry, alias.importedName) === folded)
  const ids = [...new Set(matches.map((alias) => alias.inventoryLotId))]
  return ids.length === 1 ? ids[0] : undefined
}

export function validateManualComposition(name: string, kind: ManualComposition['kind'], items: CompositionItem[]): void {
  if (!name.trim()) throw new Error('Укажите название набора')
  const error = validateCompositionItems(items)
  if (error) throw new Error(error)
  if (items.some((item) => !Number.isSafeInteger(item.quantityPerSet))) throw new Error('Количество пакетов слишком велико')
  if (items.some((item) => item.formatId !== 'drip' && item.formatId !== 'mega')) {
    throw new Error('Для сборки доступны обычные дрипы и Мега')
  }
  if (kind === 'subscription') {
    const identities = new Set(items.map((item) => item.inventoryLotId ?? exactCoffeeKey(item.country, item.coffeeName)))
    if (items.length !== 6 || identities.size !== 6 || items.some((item) => item.quantityPerSet !== 5 || item.formatId !== 'drip')) {
      throw new Error('Подписка: шесть разных лотов по пять обычных дрипов')
    }
  } else if (kind === 'x6' || kind === 'mega6') {
    if (items.length !== 1 || items[0].quantityPerSet !== 6 || items[0].formatId !== (kind === 'x6' ? 'drip' : 'mega')) {
      throw new Error(kind === 'x6' ? 'Выберите один лот по шесть обычных дрипов' : 'Выберите один лот по шесть пакетов Мега')
    }
  }
}

export function singleLotSetName(kind: ManualComposition['kind'], item?: Pick<CompositionItem, 'country' | 'coffeeName'>): string | undefined {
  if (kind !== 'x6' && kind !== 'mega6') return undefined
  if (!item?.country.trim() || !item.coffeeName.trim()) return ''
  return `${item.country.trim()} ${item.coffeeName.trim()} х6`
}

export function validateImportedComposition(name: string, kind: ImportedComposition['kind'], items: CompositionItem[]): void {
  if (!name.trim()) throw new Error('Укажите название набора')
  const error = validateCompositionItems(items)
  if (error) throw new Error(error)
  const [lotCount, quantity] = kind === 'x16' ? [4, 4] : [3, 10]
  const identities = new Set(items.map((item) => item.inventoryLotId ?? exactCoffeeKey(item.country, item.coffeeName)))
  if (items.length !== lotCount || identities.size !== lotCount || items.some((item) => item.formatId !== 'drip' || item.quantityPerSet !== quantity)) {
    throw new Error(`Выберите ${lotCount} разных лота по ${quantity} обычных дрипов`)
  }
}
