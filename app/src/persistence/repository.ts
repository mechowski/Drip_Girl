import { format } from 'date-fns'
import { db, tableNames } from './db'
import { available, buildProductionTasks, coffeeDiscrepancy, coffeeKey, normalizeCoffeeName, plannedOutput, remainingCoffee, uid, validateAllocations, validateCompositionItems } from '@/domain/calculations'
import { nextWorkingDay, scheduleDegassing } from '@/domain/calendar'
import { DEFAULT_SETTINGS, type AppSettings, type AssemblyTask, type CoffeeLot, type CompositionItem, type Employee, type FormatId, type ImportedComposition, type InventoryLot, type LotAllocation, type ManualComposition } from '@/domain/types'

const allTables = () => db.tables
const today = () => format(new Date(), 'yyyy-MM-dd')

async function audit(action: string, entityType: string, entityId: string, description: string, isDemo = false) {
  await db.auditEvents.add({ id: uid(), action, entityType, entityId, description, createdAt: new Date().toISOString(), isDemo })
}

async function warn(type: import('@/domain/types').WarningType, message: string, ids: { lotId?: string; taskId?: string; reportId?: string } = {}, isDemo = false) {
  await db.warnings.add({ id: uid(), type, message, read: false, createdAt: new Date().toISOString(), ...ids, isDemo })
}

export async function getSettings(): Promise<AppSettings> {
  return (await db.settings.get('settings')) ?? DEFAULT_SETTINGS
}

export async function updateSettings(patch: Partial<AppSettings>) {
  const current = await getSettings()
  await db.settings.put({ ...current, ...patch, id: 'settings', schemaVersion: 2, updatedAt: new Date().toISOString() })
  await audit('update', 'settings', 'settings', 'Настройки обновлены')
}

export async function addEmployee(firstName: string, lastName: string, isDemo = false): Promise<Employee> {
  if (!firstName.trim() || !lastName.trim()) throw new Error('Укажите имя и фамилию сотрудника')
  const duplicate = (await db.employees.toArray()).find((employee) => normalizeCoffeeName(employee.firstName) === normalizeCoffeeName(firstName) && normalizeCoffeeName(employee.lastName) === normalizeCoffeeName(lastName))
  if (duplicate) throw new Error('Такой сотрудник уже есть')
  const employee: Employee = { id: uid(), firstName: firstName.trim(), lastName: lastName.trim(), active: true, createdAt: new Date().toISOString(), isDemo }
  await db.employees.add(employee)
  await audit('create', 'employee', employee.id, `Добавлен сотрудник ${lastName} ${firstName}`, isDemo)
  return employee
}

export async function toggleEmployee(id: string) {
  const employee = await db.employees.get(id)
  if (!employee) throw new Error('Сотрудник не найден')
  await db.employees.update(id, { active: !employee.active })
  await audit('update', 'employee', id, employee.active ? 'Сотрудник отключён' : 'Сотрудник включён')
}

export interface NewLotInput {
  country: string
  name: string
  roastDate: string
  weightKg: number
  degassingDays: number
  responsibleId?: string
  comment?: string
  allocations: Array<{ formatId: FormatId; purpose: string; weightKg: number; degassingDays?: number; comment?: string }>
}

export async function createLot(input: NewLotInput, isDemo = false): Promise<CoffeeLot> {
  if (!input.country.trim() || !input.name.trim()) throw new Error('Укажите страну и название лота')
  if (!input.roastDate) throw new Error('Укажите дату обжарки')
  if (!Number.isInteger(input.degassingDays) || input.degassingDays < 1 || input.degassingDays > 5) throw new Error('Дегазация — от 1 до 5 дней')
  const allocationError = validateAllocations(input.weightKg, input.allocations)
  if (allocationError) throw new Error(allocationError)
  if (!input.allocations.length) throw new Error('Добавьте хотя бы одно назначение')
  const settings = await getSettings()
  const lot: CoffeeLot = { id: uid(), country: input.country.trim(), name: input.name.trim(), roastDate: input.roastDate, weightKg: input.weightKg, degassingDays: input.degassingDays, responsibleId: input.responsibleId, comment: input.comment, createdAt: new Date().toISOString(), isDemo }
  const allocations: LotAllocation[] = input.allocations.map((item) => ({ ...item, id: uid(), lotId: lot.id, isDemo }))
  const tasks = buildProductionTasks(lot, allocations, settings, scheduleDegassing).map((task) => ({ ...task, responsibleId: input.responsibleId, isDemo }))
  await db.transaction('rw', allTables(), async () => {
    await db.lots.add(lot)
    await db.allocations.bulkAdd(allocations)
    await db.productionTasks.bulkAdd(tasks)
    for (const task of tasks) {
      if (task.scheduleDecision === 'move') await warn('calendar', `${lot.country} / ${lot.name}: подтвердите перенос изготовления на ${task.plannedDate}`, { lotId: lot.id, taskId: task.id }, isDemo)
      if (task.scheduleDecision === 'bu') await warn('bu', `${lot.country} / ${lot.name}: требуется «Запаковать в Б/у» до нерабочего периода`, { lotId: lot.id, taskId: task.id }, isDemo)
    }
    await audit('create', 'lot', lot.id, `Создан лот ${lot.country} / ${lot.name}, ${lot.weightKg} кг`, isDemo)
  })
  return lot
}

export async function approveSchedule(taskId: string) {
  const task = await db.productionTasks.get(taskId)
  if (!task) throw new Error('Задача не найдена')
  await db.productionTasks.update(taskId, { approved: true })
  await audit('approve', 'production', taskId, 'Производственная дата подтверждена администратором')
}

export async function markBU(taskId: string) {
  await db.transaction('rw', allTables(), async () => {
    const task = await db.productionTasks.get(taskId)
    if (!task) throw new Error('Задача не найдена')
    await db.productionTasks.update(taskId, { inBU: true, approved: true })
    await db.inventory.where('productionTaskId').equals(taskId).modify({ inBU: true })
    await audit('update', 'production', taskId, 'Выполнена операция «Запаковать в Б/у»')
  })
}

export async function produce(taskId: string, quantity: number, responsibleId: string, comment = '', isDemo = false) {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Количество должно быть целым положительным числом')
  await db.transaction('rw', allTables(), async () => {
    const task = await db.productionTasks.get(taskId)
    if (!task || task.status === 'cancelled') throw new Error('Задача недоступна')
    if (!task.approved) throw new Error('Сначала подтвердите производственную дату')
    const employee = await db.employees.get(responsibleId)
    if (!employee?.active) throw new Error('Выберите активного ответственного')
    const lot = await db.lots.get(task.lotId)
    const settings = await getSettings()
    const format = settings.formats.find((item) => item.id === task.formatId)
    if (!lot || !format) throw new Error('Данные лота или формата повреждены')
    const createdAt = new Date().toISOString()
    const entry = { id: uid(), taskId, lotId: lot.id, quantity, responsibleId, coefficientSnapshot: format.coefficient, createdAt, comment, isDemo }
    await db.productionEntries.add(entry)
    const allocations = await db.allocations.where('lotId').equals(lot.id).toArray()
    const relevant = allocations.filter((item) => item.formatId === task.formatId)
    let remaining = quantity
    for (const [index, allocation] of relevant.entries()) {
      const target = plannedOutput(allocation.weightKg, format.coefficient)
      const existing = (await db.inventory.where('productionTaskId').equals(taskId).toArray()).filter((item) => item.purpose === allocation.purpose).reduce((sum, item) => sum + item.quantity, 0)
      const part = index === relevant.length - 1 ? remaining : Math.min(remaining, Math.max(0, target - existing))
      if (part <= 0) continue
      const inventoryLot: InventoryLot = { id: uid(), sourceLotId: lot.id, productionTaskId: taskId, country: lot.country, coffeeName: lot.name, formatId: task.formatId, purpose: allocation.purpose, quantity: part, reserved: 0, manufacturedAt: createdAt, createdAt, inBU: task.inBU, isDemo }
      await db.inventory.add(inventoryLot)
      await db.inventoryTransactions.add({ id: uid(), inventoryLotId: inventoryLot.id, type: 'receipt', quantity: part, previousQuantity: 0, newQuantity: part, author: `${employee.lastName} ${employee.firstName}`, createdAt, isDemo })
      remaining -= part
      if (remaining <= 0) break
    }
    const producedQuantity = task.producedQuantity + quantity
    await db.productionTasks.update(taskId, { producedQuantity, status: producedQuantity >= task.plannedQuantity ? 'completed' : 'open', responsibleId, comment: comment || task.comment })
    const changed = { ...task, producedQuantity }
    if (coffeeDiscrepancy(changed, format)) await warn('discrepancy', `${lot.country} / ${lot.name}: фактический расход превысил расчётный остаток`, { lotId: lot.id, taskId }, isDemo)
    await audit('produce', 'production', taskId, `Изготовлено ${quantity} шт. (${format.name})`, isDemo)
  })
}

export async function writeOffProduction(taskId: string, weightKg: number, reason: string) {
  if (weightKg <= 0 || !reason.trim()) throw new Error('Укажите положительный вес и причину списания')
  await db.transaction('rw', allTables(), async () => {
    const task = await db.productionTasks.get(taskId)
    if (!task) throw new Error('Задача не найдена')
    const remaining = remainingCoffee(task, (await getSettings()).formats.find((item) => item.id === task.formatId)!)
    if (weightKg > remaining + 1e-9) throw new Error('Нельзя списать больше расчётного остатка')
    await db.productionTasks.update(taskId, { writtenOffKg: task.writtenOffKg + weightKg })
    await audit('writeoff', 'production', taskId, `Списано ${weightKg} кг: ${reason}`)
  })
}

export async function adjustInventory(inventoryLotId: string, newQuantity: number, reason: string, comment = '') {
  if (!Number.isInteger(newQuantity) || newQuantity < 0 || !reason.trim()) throw new Error('Укажите неотрицательное целое количество и причину')
  await db.transaction('rw', allTables(), async () => {
    const lot = await db.inventory.get(inventoryLotId)
    if (!lot) throw new Error('Позиция стока не найдена')
    if (newQuantity < lot.reserved) throw new Error('Количество меньше активного резерва')
    await db.inventory.update(inventoryLotId, { quantity: newQuantity })
    await db.inventoryTransactions.add({ id: uid(), inventoryLotId, type: 'adjust', quantity: newQuantity - lot.quantity, previousQuantity: lot.quantity, newQuantity, reason, comment, author: 'Администратор', createdAt: new Date().toISOString() })
    await db.adjustments.add({ id: uid(), entityType: 'inventory', entityId: inventoryLotId, previousValue: lot.quantity, newValue: newQuantity, reason, comment, createdAt: new Date().toISOString() })
    await warn('adjustment', `${lot.country} / ${lot.coffeeName}: остаток изменён с ${lot.quantity} до ${newQuantity}`, { lotId: lot.sourceLotId })
    await audit('adjust', 'inventory', inventoryLotId, `Корректировка: ${lot.quantity} → ${newQuantity}`)
  })
}

export async function reassignInventory(inventoryLotId: string, purpose: string, quantity: number) {
  if (!purpose.trim() || !Number.isInteger(quantity) || quantity <= 0) throw new Error('Укажите назначение и положительное количество')
  await db.transaction('rw', allTables(), async () => {
    const lot = await db.inventory.get(inventoryLotId)
    if (!lot || quantity > available(lot)) throw new Error('Недостаточно доступного остатка')
    const nextPurpose = purpose.trim()
    if (quantity === lot.quantity) {
      await db.inventory.update(inventoryLotId, { purpose: nextPurpose })
    } else {
      await db.inventory.update(inventoryLotId, { quantity: lot.quantity - quantity })
      await db.inventory.add({ ...lot, id: uid(), purpose: nextPurpose, quantity, reserved: 0, createdAt: new Date().toISOString(), isDemo: false })
    }
    await db.inventoryTransactions.add({ id: uid(), inventoryLotId, type: 'reassign', quantity, previousQuantity: lot.quantity, newQuantity: lot.quantity - quantity, reason: `Новое назначение: ${nextPurpose}`, author: 'Администратор', createdAt: new Date().toISOString() })
    await audit('reassign', 'inventory', inventoryLotId, `Переназначено ${quantity} шт. на ${nextPurpose}`)
  })
}

export async function addManualComposition(name: string, kind: ManualComposition['kind'], items: CompositionItem[], isDemo = false) {
  if (!name.trim()) throw new Error('Укажите название набора')
  const error = validateCompositionItems(items)
  if (error) throw new Error(error)
  if (kind === 'subscription' && (items.length !== 6 || items.some((item) => item.quantityPerSet !== 5))) throw new Error('Подписка: ровно 6 лотов по 5 дрипов')
  if ((kind === 'x6' || kind === 'mega6') && (items.length !== 1 || items[0].quantityPerSet !== 6)) throw new Error('Этот набор содержит один лот по 6 пакетов')
  await db.manualCompositions.add({ id: uid(), name: name.trim(), kind, items, enabled: true, createdAt: new Date().toISOString(), isDemo })
}

export async function toggleComposition(id: string, imported: boolean) {
  const table = imported ? db.importedCompositions : db.manualCompositions
  const composition = await table.get(id)
  if (!composition) throw new Error('Состав не найден')
  await table.update(id, { enabled: !composition.enabled })
}

export async function saveImportedCompositions(connectionId: string, compositions: ImportedComposition[], sheetNames: string[]) {
  if (!compositions.length) throw new Error('Импорт не содержит корректных составов; прежние данные сохранены')
  await db.transaction('rw', allTables(), async () => {
    const old = await db.importedCompositions.where('sheetConnectionId').equals(connectionId).toArray()
    const merged = compositions.map((composition) => ({ ...composition, enabled: old.find((item) => item.name === composition.name && item.sheetName === composition.sheetName)?.enabled ?? composition.enabled }))
    await db.importedCompositions.where('sheetConnectionId').equals(connectionId).delete()
    await db.importedCompositions.bulkAdd(merged)
    await db.sheetConnections.update(connectionId, { selectedSheets: sheetNames, lastSuccessAt: new Date().toISOString(), lastError: undefined })
  })
}

export async function saveAlias(importedCountry: string, importedName: string, sourceLotId: string) {
  const existing = (await db.aliases.toArray()).find((alias) => coffeeKey(alias.importedCountry, alias.importedName) === coffeeKey(importedCountry, importedName))
  if (existing) await db.aliases.update(existing.id, { inventoryLotId: sourceLotId })
  else await db.aliases.add({ id: uid(), importedCountry, importedName, inventoryLotId: sourceLotId, createdAt: new Date().toISOString() })
  const imported = await db.importedCompositions.toArray()
  for (const composition of imported) {
    let changed = false
    const items = composition.items.map((item) => {
      if (coffeeKey(item.country, item.coffeeName) === coffeeKey(importedCountry, importedName)) { changed = true; return { ...item, inventoryLotId: sourceLotId } }
      return item
    })
    if (changed) await db.importedCompositions.update(composition.id, { items })
  }
}

export async function createAssemblyPlan(entries: Array<{ composition: ManualComposition | ImportedComposition; quantity: number }>, date = today(), isDemo = false) {
  if (!entries.length) throw new Error('Добавьте хотя бы один состав в план')
  if (entries.some((entry) => !Number.isInteger(entry.quantity) || entry.quantity <= 0)) throw new Error('Количество наборов должно быть целым положительным числом')
  const planId = uid()
  const aliases = await db.aliases.toArray()
  await db.transaction('rw', allTables(), async () => {
    await db.assemblyPlans.add({ id: planId, date, status: 'draft', createdAt: new Date().toISOString(), isDemo })
    for (const entry of entries) {
      if (!entry.composition.enabled) throw new Error(`Состав «${entry.composition.name}» отключён`)
      const items = entry.composition.items.map((item) => ({ ...item, inventoryLotId: item.inventoryLotId ?? aliases.find((alias) => coffeeKey(alias.importedCountry, alias.importedName) === coffeeKey(item.country, item.coffeeName))?.inventoryLotId }))
      await db.assemblyTasks.add({ id: uid(), planId, compositionId: entry.composition.id, compositionKind: entry.composition.kind, compositionSnapshot: items, name: entry.composition.name, plannedQuantity: entry.quantity, completedQuantity: 0, status: 'pending', productionDate: date, createdAt: new Date().toISOString(), isDemo })
    }
    await audit('create', 'assembly', planId, `Создан план сборки: ${entries.length} заданий`, isDemo)
  })
  return planId
}

function itemMatchesLot(item: CompositionItem, lot: InventoryLot): boolean {
  if (item.formatId !== lot.formatId) return false
  return item.inventoryLotId ? item.inventoryLotId === lot.sourceLotId : coffeeKey(item.country, item.coffeeName) === coffeeKey(lot.country, lot.coffeeName)
}

export async function confirmAssemblyPlan(planId: string) {
  await db.transaction('rw', allTables(), async () => {
    const tasks = await db.assemblyTasks.where('planId').equals(planId).toArray()
    if (!tasks.length || tasks.some((task) => task.status !== 'pending')) throw new Error('План уже подтверждён или пуст')
    for (const task of tasks) {
      for (const item of task.compositionSnapshot) {
        let needed = item.quantityPerSet * task.plannedQuantity
        const lots = (await db.inventory.toArray()).filter((lot) => itemMatchesLot(item, lot)).sort((a, b) => a.manufacturedAt.localeCompare(b.manufacturedAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        if (!lots.length) throw new Error(`Не сопоставлен лот: ${item.country} / ${item.coffeeName}`)
        for (const lot of lots) {
          const amount = Math.min(needed, available(lot))
          if (amount <= 0) continue
          await db.reservations.add({ id: uid(), assemblyTaskId: task.id, compositionId: task.compositionId, inventoryLotId: lot.id, quantity: amount, consumedQuantity: 0, status: 'active', createdAt: new Date().toISOString() })
          await db.inventory.update(lot.id, { reserved: lot.reserved + amount })
          await db.inventoryTransactions.add({ id: uid(), inventoryLotId: lot.id, type: 'reserve', quantity: amount, previousQuantity: lot.quantity, newQuantity: lot.quantity, previousReserved: lot.reserved, newReserved: lot.reserved + amount, assemblyTaskId: task.id, author: 'Администратор', createdAt: new Date().toISOString() })
          needed -= amount
          if (needed === 0) break
        }
        if (needed > 0) throw new Error(`Недостаточно стока для «${task.name}»: ${item.country} / ${item.coffeeName}, не хватает ${needed} шт.`)
      }
      await db.assemblyTasks.update(task.id, { status: 'confirmed' })
    }
    await db.assemblyPlans.update(planId, { status: 'confirmed' })
    await audit('confirm', 'assembly', planId, 'План подтверждён, сток зарезервирован')
  })
}

async function consumeReport(task: AssemblyTask, reportId: string, employeeId: string, quantity: number, productionDate: string, comment: string, isDemo: boolean, record = true) {
  const employee = await db.employees.get(employeeId)
  if (!employee || (record && !employee.active)) throw new Error('Выберите активного сотрудника')
  const deductions: import('@/domain/types').DeductionDetail[] = []
  for (const item of task.compositionSnapshot) {
    let needed = item.quantityPerSet * quantity
    const reservations = (await db.reservations.where('assemblyTaskId').equals(task.id).toArray()).filter((reservation) => reservation.status === 'active')
    const pairs = []
    for (const reservation of reservations) {
      const lot = await db.inventory.get(reservation.inventoryLotId)
      if (lot && itemMatchesLot(item, lot)) pairs.push({ reservation, lot })
    }
    pairs.sort((a, b) => a.lot.manufacturedAt.localeCompare(b.lot.manufacturedAt) || a.lot.createdAt.localeCompare(b.lot.createdAt) || a.lot.id.localeCompare(b.lot.id))
    for (const { reservation, lot } of pairs) {
      const left = reservation.quantity - reservation.consumedQuantity
      const amount = Math.min(needed, left)
      if (amount <= 0) continue
      if (lot.quantity < amount || lot.reserved < amount) throw new Error('Резерв повреждён: операция отменена')
      await db.inventory.update(lot.id, { quantity: lot.quantity - amount, reserved: lot.reserved - amount })
      const consumedQuantity = reservation.consumedQuantity + amount
      await db.reservations.update(reservation.id, { consumedQuantity, status: consumedQuantity === reservation.quantity ? 'completed' : 'active' })
      await db.inventoryTransactions.add({ id: uid(), inventoryLotId: lot.id, type: 'consume', quantity: -amount, previousQuantity: lot.quantity, newQuantity: lot.quantity - amount, previousReserved: lot.reserved, newReserved: lot.reserved - amount, assemblyTaskId: task.id, reportId, author: `${employee.lastName} ${employee.firstName}`, createdAt: new Date().toISOString(), isDemo })
      deductions.push({ inventoryLotId: lot.id, reservationId: reservation.id, quantity: amount, manufacturedAt: lot.manufacturedAt })
      needed -= amount
      if (needed === 0) break
    }
    if (needed > 0) throw new Error(`Не хватает резерва для списания ${needed} шт.`)
  }
  if (record) await db.assemblyReports.add({ id: reportId, taskId: task.id, employeeId, quantity, deductions, createdAt: new Date().toISOString(), comment, productionDate, isDemo })
  return deductions
}

export async function correctAssemblyReport(reportId: string, newQuantity: number, correctionComment: string) {
  if (!Number.isInteger(newQuantity) || newQuantity < 0 || !correctionComment.trim()) throw new Error('Укажите неотрицательное целое количество и комментарий исправления')
  await db.transaction('rw', allTables(), async () => {
    const report = await db.assemblyReports.get(reportId)
    if (!report) throw new Error('Отчёт не найден')
    const task = await db.assemblyTasks.get(report.taskId)
    if (!task) throw new Error('Задание не найдено')
    const delta = newQuantity - report.quantity
    if (delta === 0) throw new Error('Количество не изменилось')
    if (delta > 0 && delta > task.plannedQuantity - task.completedQuantity) throw new Error('Исправление превышает остаток задания')
    let deductions = [...report.deductions]
    if (delta > 0) {
      deductions = [...deductions, ...await consumeReport(task, report.id, report.employeeId, delta, report.productionDate, correctionComment, false, false)]
    } else {
      const deductionsToRestore = report.deductions.map((item) => ({ ...item }))
      for (const item of task.compositionSnapshot) {
        let needed = item.quantityPerSet * -delta
        for (const deduction of deductionsToRestore) {
          const lot = await db.inventory.get(deduction.inventoryLotId)
          const reservation = await db.reservations.get(deduction.reservationId)
          if (!lot || !reservation || !itemMatchesLot(item, lot)) continue
          const amount = Math.min(needed, deduction.quantity)
          if (amount <= 0) continue
          await db.inventory.update(lot.id, { quantity: lot.quantity + amount, reserved: lot.reserved + amount })
          await db.reservations.update(reservation.id, { consumedQuantity: reservation.consumedQuantity - amount, status: 'active' })
          await db.inventoryTransactions.add({ id: uid(), inventoryLotId: lot.id, type: 'adjust', quantity: amount, previousQuantity: lot.quantity, newQuantity: lot.quantity + amount, previousReserved: lot.reserved, newReserved: lot.reserved + amount, assemblyTaskId: task.id, reportId, reason: correctionComment, author: 'Администратор', createdAt: new Date().toISOString() })
          deduction.quantity -= amount
          needed -= amount
          if (needed === 0) break
        }
        if (needed > 0) throw new Error('Не удалось восстановить резерв по детализации отчёта')
      }
      deductions = deductionsToRestore.filter((item) => item.quantity > 0)
    }
    await db.assemblyReports.update(reportId, { quantity: newQuantity, previousQuantity: report.quantity, correctionComment, correctedAt: new Date().toISOString(), deductions })
    const completedQuantity = task.completedQuantity + delta
    await db.assemblyTasks.update(task.id, { completedQuantity, status: completedQuantity === task.plannedQuantity ? 'completed' : 'partial' })
    await db.adjustments.add({ id: uid(), entityType: 'report', entityId: reportId, previousValue: report.quantity, newValue: newQuantity, reason: correctionComment, createdAt: new Date().toISOString() })
    await audit('correct', 'report', reportId, `Отчёт исправлен: ${report.quantity} → ${newQuantity}. ${correctionComment}`)
  })
}

export async function reportAssembly(taskId: string, employeeId: string, quantity: number, comment = '', isDemo = false) {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Введите целое положительное количество')
  await db.transaction('rw', allTables(), async () => {
    const task = await db.assemblyTasks.get(taskId)
    if (!task || !['confirmed', 'partial', 'transferred'].includes(task.status)) throw new Error('Задание недоступно для отчёта')
    const remaining = task.plannedQuantity - task.completedQuantity
    if (quantity > remaining) throw new Error(`Осталось только ${remaining} наборов`)
    const date = today()
    if (await db.productionDays.where('date').equals(date).first()) throw new Error('Производственный день уже закрыт')
    const reportId = uid()
    await consumeReport(task, reportId, employeeId, quantity, date, comment, isDemo)
    const completedQuantity = task.completedQuantity + quantity
    await db.assemblyTasks.update(taskId, { completedQuantity, status: completedQuantity === task.plannedQuantity ? 'completed' : 'partial' })
    await audit('report', 'assembly', taskId, `Отчёт: ${quantity} наборов`, isDemo)
  })
}

export async function warnAdmin(taskId: string, message: string) {
  if (!message.trim()) throw new Error('Напишите сообщение администратору')
  await warn('employee', message, { taskId })
}

export async function cancelAssemblyTask(taskId: string, reason: string) {
  if (!reason.trim()) throw new Error('Укажите причину отмены')
  await db.transaction('rw', allTables(), async () => {
    const task = await db.assemblyTasks.get(taskId)
    if (!task || task.status === 'completed') throw new Error('Завершённое задание нельзя отменить')
    const reservations = await db.reservations.where('assemblyTaskId').equals(taskId).toArray()
    for (const reservation of reservations.filter((item) => item.status === 'active')) {
      const lot = await db.inventory.get(reservation.inventoryLotId)
      if (!lot) continue
      const amount = reservation.quantity - reservation.consumedQuantity
      await db.inventory.update(lot.id, { reserved: Math.max(0, lot.reserved - amount) })
      await db.reservations.update(reservation.id, { status: 'released' })
      await db.inventoryTransactions.add({ id: uid(), inventoryLotId: lot.id, type: 'release', quantity: amount, previousQuantity: lot.quantity, newQuantity: lot.quantity, previousReserved: lot.reserved, newReserved: Math.max(0, lot.reserved - amount), assemblyTaskId: taskId, reason, author: 'Администратор', createdAt: new Date().toISOString() })
    }
    await db.assemblyTasks.update(taskId, { status: 'cancelled' })
    await audit('cancel', 'assembly', taskId, `Задание отменено: ${reason}`)
  })
}

export async function closeProductionDay(date = today()) {
  const settings = await getSettings()
  await db.transaction('rw', allTables(), async () => {
    if (await db.dailyReports.where('date').equals(date).first()) throw new Error('Этот день уже завершён')
    const entries = (await db.productionEntries.toArray()).filter((entry) => entry.createdAt.startsWith(date))
    const reports = (await db.assemblyReports.toArray()).filter((report) => report.productionDate === date)
    const tasks = await db.assemblyTasks.toArray()
    const employees = await db.employees.toArray()
    const assembled = tasks.filter((task) => reports.some((report) => report.taskId === task.id) || ['confirmed', 'partial'].includes(task.status)).map((task) => {
      const own = reports.filter((report) => report.taskId === task.id)
      return { taskId: task.id, name: task.name, plan: task.plannedQuantity, fact: own.reduce((sum, report) => sum + report.quantity, 0), remaining: task.plannedQuantity - task.completedQuantity, employees: [...new Set(own.map((report) => { const employee = employees.find((item) => item.id === report.employeeId); return employee ? `${employee.lastName} ${employee.firstName}` : 'Неизвестно' }))], comments: own.map((report) => report.comment).filter((comment): comment is string => Boolean(comment)) }
    })
    const warnings = await db.warnings.toArray()
    await db.dailyReports.add({ id: uid(), date, produced: entries, assembled, warnings, createdAt: new Date().toISOString() })
    await db.productionDays.add({ id: uid(), date, status: 'closed', closedAt: new Date().toISOString(), nextWorkingDate: format(nextWorkingDay(date, settings), 'yyyy-MM-dd') })
    const next = format(nextWorkingDay(date, settings), 'yyyy-MM-dd')
    for (const task of tasks.filter((item) => ['confirmed', 'partial'].includes(item.status))) {
      await db.assemblyTasks.update(task.id, { status: 'transferred', productionDate: next })
      await warn('unfinished', `«${task.name}»: остаток ${task.plannedQuantity - task.completedQuantity} перенесён на ${next}`, { taskId: task.id })
    }
    await audit('close', 'day', date, `Производственный день ${date} завершён`)
  })
}

export async function clearDemoData() {
  await db.transaction('rw', allTables(), async () => {
    for (const name of tableNames) {
      if (name === 'settings') continue
      const table = db.table(name)
      const rows = await table.toArray()
      const demoIds = rows.filter((row) => row.isDemo).map((row) => row.id)
      if (demoIds.length) await table.bulkDelete(demoIds)
    }
  })
}

export async function seedDemoData() {
  if ((await db.lots.filter((lot) => Boolean(lot.isDemo)).count()) > 0) throw new Error('Демонстрационные данные уже добавлены')
  const first = await addEmployee('Анна', 'Иванова', true)
  await addEmployee('Мария', 'Петрова', true)
  const coffees = [['Эфиопия', 'Гуджи'], ['Колумбия', 'Уила'], ['Бразилия', 'Серрадо'], ['Кения', 'Ньери']]
  for (const [country, name] of coffees) {
    const lot = await createLot({ country, name, roastDate: today(), weightKg: 2.5, degassingDays: 3, responsibleId: first.id, allocations: [{ formatId: 'drip', purpose: '×16', weightKg: 2.5 }] }, true)
    const task = await db.productionTasks.where('lotId').equals(lot.id).first()
    if (task) {
      if (!task.approved) await approveSchedule(task.id)
      await produce(task.id, task.plannedQuantity, first.id, 'Демонстрационное изготовление', true)
    }
  }
  const inventory = await db.inventory.toArray()
  const items: CompositionItem[] = coffees.map(([country, name]) => ({ id: uid(), country, coffeeName: name, formatId: 'drip', quantityPerSet: 4, inventoryLotId: inventory.find((lot) => lot.country === country && lot.coffeeName === name)?.sourceLotId }))
  await db.importedCompositions.add({ id: uid(), sheetConnectionId: 'demo', sheetName: '×16', column: 1, name: 'Восточная коллекция ×16', kind: 'x16', items, enabled: true, metadata: { Источник: 'Демонстрационные данные' }, importedAt: new Date().toISOString(), isDemo: true })
}
