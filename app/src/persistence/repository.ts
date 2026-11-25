import { addDays, format, parseISO } from 'date-fns'
import { db, tableNames } from './db'
import { consumeReservedInventory, releaseExpectedReservations, reportAgainstExpected, reserveInventory, restoreExpectedDeduction, settleExpectedReservations } from './stockReservations'
import { fitsExpectedReservations, previewAssemblyReservation } from '@/domain/expectedOutput'
import { hasAdminSession } from '@/domain/adminSession'
import { assemblyParticipantNames } from '@/domain/assemblyReports'
export { addManualComposition, saveAlias, saveImportedCompositions, toggleComposition, updateManualComposition } from './compositions'
import { available, buildProductionTasks, coffeeDiscrepancy, coffeeKey, compareStockFifo, describeShortage, isPrivateLabel, lotHasProductionActivity, matchesTaskAllocation, needsStockReassignment, normalizeCoffeeName, plannedOutput, plannedTaskSchedule, productionScheduleWarning, productionTaskKey, purposesForFormat, remainingCoffee, sameSchedule, splitProductionReceipt, uid, validateAllocations } from '@/domain/calculations'
import { singleLotSetName } from '@/domain/compositions'
import { assertDegassingDays, isCalendarDate, nextShiftDate, parseCalendarSource, scheduleDegassing } from '@/domain/calendar'
import { DEFAULT_SETTINGS, SCHEMA_VERSION, type AppSettings, type AssemblyTask, type CalendarSource, type CoffeeLot, type DailyReport, type AssemblyReport, type CompositionItem, type Employee, type FormatId, type ImportedComposition, type InventoryLot, type LotAllocation, type ManualComposition, type ProductionEntry, type ProductionTask } from '@/domain/types'

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
  await db.transaction('rw', [db.settings, db.auditEvents, db.expectedReservations, db.productionTasks, db.allocations, db.productionEntries], async () => {
    const current = await getSettings()
    const next = { ...current, ...patch, id: 'settings' as const, schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString() }
    if (!next.adminPassword.trim()) throw new Error('Укажите пароль администратора')
    if (next.formats.some((item) => !item.name.trim() || !Number.isFinite(item.coefficient) || item.coefficient <= 0)) {
      throw new Error('Укажите название и положительный коэффициент каждого формата')
    }
    if (patch.formats) {
      const affected = new Set(next.formats.filter((item) =>
        item.coefficient !== current.formats.find(({ id }) => id === item.id)?.coefficient).map(({ id }) => id))
      if (affected.size) {
        const claims = await db.expectedReservations.toArray()
        const taskIds = [...new Set(claims.map(({ productionTaskId }) => productionTaskId))]
        const tasks = (await db.productionTasks.bulkGet(taskIds)).filter((task) => task && affected.has(task.formatId))
        for (const task of tasks) {
          if (!task) continue
          const [allocations, entries] = await Promise.all([
            db.allocations.where('lotId').equals(task.lotId).toArray(),
            db.productionEntries.where('taskId').equals(task.id).toArray(),
          ])
          if (!fitsExpectedReservations(task, next, allocations, entries, claims.filter(({ productionTaskId }) => productionTaskId === task.id))) {
            throw new Error('Новый коэффициент уменьшает выпуск ниже подтверждённого резерва сборки')
          }
        }
      }
    }
    await db.settings.put(next)
    await audit('update', 'settings', 'settings', 'Настройки обновлены')
  })
}

export async function addEmployee(firstName: string, lastName: string, isDemo = false): Promise<Employee> {
  if (!firstName.trim() || !lastName.trim()) throw new Error('Укажите имя и фамилию сотрудника')
  return db.transaction('rw', db.employees, db.auditEvents, async () => {
    const duplicate = (await db.employees.toArray()).some((employee) =>
      normalizeCoffeeName(employee.firstName) === normalizeCoffeeName(firstName)
      && normalizeCoffeeName(employee.lastName) === normalizeCoffeeName(lastName))
    if (duplicate) throw new Error('Такой сотрудник уже есть')
    const employee: Employee = { id: uid(), firstName: firstName.trim(), lastName: lastName.trim(), active: true, createdAt: new Date().toISOString(), isDemo }
    await db.employees.add(employee)
    await audit('create', 'employee', employee.id, `Добавлен сотрудник ${lastName} ${firstName}`, isDemo)
    return employee
  })
}

export async function toggleEmployee(id: string) {
  await db.transaction('rw', db.employees, db.auditEvents, async () => {
    const employee = await db.employees.get(id)
    if (!employee) throw new Error('Сотрудник не найден')
    await db.employees.update(id, { active: !employee.active })
    await audit('update', 'employee', id, employee.active ? 'Сотрудник отключён' : 'Сотрудник включён', employee.isDemo)
  })
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

function lotIdentity(input: Pick<NewLotInput, 'country' | 'name' | 'comment'>) {
  if (!input.country.trim() || !input.name.trim()) throw new Error('Укажите страну и название лота')
  return { country: input.country.trim(), name: input.name.trim(), comment: input.comment }
}

function lotFields(input: NewLotInput) {
  const identity = lotIdentity(input)
  if (!isCalendarDate(input.roastDate)) throw new Error('Укажите корректную дату обжарки')
  assertDegassingDays(input.degassingDays)
  if (!input.allocations.length) throw new Error('Добавьте хотя бы одно назначение')
  const allocationError = validateAllocations(input.weightKg, input.allocations)
  if (allocationError) throw new Error(allocationError)
  return { ...identity, roastDate: input.roastDate, weightKg: input.weightKg, degassingDays: input.degassingDays, responsibleId: input.responsibleId }
}

async function lotAllocations(lot: CoffeeLot, input: NewLotInput, settings: AppSettings, current: LotAllocation[] = []) {
  if (input.responsibleId && !(await db.employees.get(input.responsibleId))?.active) throw new Error('Выберите активного ответственного')
  return input.allocations.map((item, position): LotAllocation => {
    if (item.degassingDays !== undefined) assertDegassingDays(item.degassingDays)
    if (!purposesForFormat(item.formatId, settings.purposes).includes(item.purpose)) throw new Error('Выберите назначение для каждого формата')
    return { ...item, position, id: current[position]?.id ?? uid(), lotId: lot.id, isDemo: lot.isDemo }
  })
}

export async function createLot(input: NewLotInput, isDemo = false): Promise<CoffeeLot> {
  const lot: CoffeeLot = { id: uid(), ...lotFields(input), createdAt: new Date().toISOString(), isDemo }
  await db.transaction('rw', allTables(), async () => {
    const settings = await getSettings()
    const allocations = await lotAllocations(lot, input, settings)
    const tasks = buildProductionTasks(lot, allocations, settings, scheduleDegassing)
      .map((task) => ({ ...task, responsibleId: lot.responsibleId, isDemo }))
    await db.lots.add(lot)
    await db.allocations.bulkAdd(allocations)
    await db.productionTasks.bulkAdd(tasks)
    for (const task of tasks) await warnAboutSchedule(lot, task)
    await audit('create', 'lot', lot.id, `Создан лот ${lot.country} / ${lot.name}, ${lot.weightKg} кг`, isDemo)
  })
  return lot
}

async function readLotActivity(lotId: string) {
  const [tasks, entries, inventory] = await Promise.all([
    db.productionTasks.where('lotId').equals(lotId).toArray(),
    db.productionEntries.filter((entry) => entry.lotId === lotId).first(),
    db.inventory.where('sourceLotId').equals(lotId).toArray(),
  ])
  const expected = tasks.length
    ? await db.expectedReservations.where('productionTaskId').anyOf(tasks.map(({ id }) => id)).first() : undefined
  return { tasks, inventory, expected, hasActivity: lotHasProductionActivity(tasks, Boolean(entries), inventory.length > 0) }
}

async function updateLotLabels(lot: CoffeeLot, inventory: InventoryLot[]) {
  const labels = { country: lot.country, coffeeName: lot.name }
  await db.inventory.bulkPut(inventory.map((item) => ({ ...item, ...labels })))
  const manual = await db.manualCompositions.filter(({ items }) => items.some((item) => item.inventoryLotId === lot.id)).toArray()
  await db.manualCompositions.bulkPut(manual.map((composition) => {
    const items = composition.items.map((item) => item.inventoryLotId === lot.id ? { ...item, ...labels } : item)
    return { ...composition, items, name: singleLotSetName(composition.kind, items[0]) ?? composition.name }
  }))
}

export async function updateLot(lotId: string, input: Pick<NewLotInput, 'country' | 'name' | 'comment'> | NewLotInput) {
  await db.transaction('rw', allTables(), async () => {
    const previous = await db.lots.get(lotId)
    if (!previous) throw new Error('Лот не найден')
    const { tasks, inventory, expected, hasActivity } = await readLotActivity(lotId)
    const renamed = previous.country !== input.country.trim() || previous.name !== input.name.trim()
    let lot = { ...previous, ...lotIdentity(input) }
    if ('allocations' in input) {
      if (expected) throw new Error('Под выпуск этого лота уже подтверждён резерв сборки')
      if (hasActivity) throw new Error('После начала производства можно исправить только страну, название и комментарий')
      lot = { ...previous, ...lotFields(input) }
      const current = (await db.allocations.where('lotId').equals(lotId).toArray()).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      const settings = await getSettings()
      const allocations = await lotAllocations(lot, input, settings, current)
      const byFormat = new Map(tasks.map((task) => [task.formatId, task]))
      const byPurpose = new Map(tasks.map((task) => [productionTaskKey(task), task]))
      const usedTaskIds = new Set<string>()
      const planningSettings = { ...settings, formats: settings.formats.map((item) => ({
        ...item, coefficient: byFormat.get(item.id)?.coefficientSnapshot ?? item.coefficient,
      })) }
      const nextTasks = buildProductionTasks(lot, allocations, planningSettings, scheduleDegassing).map((task) => {
        const previous = byPurpose.get(productionTaskKey(task)) ?? byPurpose.get(productionTaskKey({ formatId: task.formatId }))
        const old = previous && !usedTaskIds.has(previous.id) ? previous : undefined
        if (old) usedTaskIds.add(old.id)
        const coefficient = old?.coefficientSnapshot ?? task.coefficientSnapshot!
        const plannedQuantity = allocations.filter((allocation) => matchesTaskAllocation(task, allocation))
          .reduce((sum, allocation) => sum + plannedOutput(allocation.weightKg, coefficient), 0)
        if (!Number.isSafeInteger(plannedQuantity)) throw new Error('Слишком большое плановое количество')
        return { ...task, coefficientSnapshot: coefficient, plannedQuantity, id: old?.id ?? task.id, createdAt: old?.createdAt ?? task.createdAt,
          approved: old && sameSchedule(old, task) ? old.approved : task.approved, responsibleId: lot.responsibleId, isDemo: lot.isDemo }
      })
      const oldById = new Map(tasks.map((task) => [task.id, task]))
      const nextById = new Map(nextTasks.map((task) => [task.id, task]))
      const obsolete = tasks.filter((task) => !nextById.has(task.id))
      await db.allocations.bulkDelete(current.slice(allocations.length).map(({ id }) => id))
      await db.allocations.bulkPut(allocations)
      await db.productionTasks.bulkDelete(obsolete.map(({ id }) => id))
      await db.productionTasks.bulkPut(nextTasks)
      for (const task of tasks) {
        const next = nextById.get(task.id)
        if (!next || renamed || !sameSchedule(task, next)) await readScheduleWarnings(task.id, ['calendar', 'bu'])
      }
      for (const task of nextTasks) {
        const old = oldById.get(task.id)
        if (!task.approved && (!old || renamed || !sameSchedule(old, task))) await warnAboutSchedule(lot, task)
      }
    }
    if (renamed) await updateLotLabels(lot, inventory)
    await db.lots.put(lot)
    await audit('update', 'lot', lotId, `Изменён лот ${lot.country} / ${lot.name}`, lot.isDemo)
  })
}

export async function deleteLot(lotId: string) {
  await db.transaction('rw', allTables(), async () => {
    const lot = await db.lots.get(lotId)
    if (!lot) throw new Error('Лот не найден')
    const { tasks, expected, hasActivity } = await readLotActivity(lotId)
    if (expected) throw new Error('Под выпуск этого лота уже подтверждён резерв сборки')
    if (hasActivity) throw new Error('У лота есть выпуск, списание, упаковка в Б/у или партия на стоке')
    const usesLot = ({ items }: Pick<ManualComposition, 'items'>) => items.some((item) => item.inventoryLotId === lotId)
    const [manual, imported] = await Promise.all([
      db.manualCompositions.filter(usesLot).first(),
      db.importedCompositions.filter((item) => !item.removed && usesLot(item)).first(),
    ])
    if (manual || imported) throw new Error('Лот используется в составе. Сначала замените его в составе')
    await db.aliases.where('inventoryLotId').equals(lotId).delete()
    await db.allocations.where('lotId').equals(lotId).delete()
    await db.productionTasks.bulkDelete(tasks.map(({ id }) => id))
    await db.warnings.filter((warning) => warning.lotId === lotId && !warning.read).modify({ read: true })
    await db.lots.delete(lotId)
    await audit('delete', 'lot', lotId, `Удалён лот ${lot.country} / ${lot.name}`, lot.isDemo)
  })
}

async function warnAboutSchedule(lot: CoffeeLot, task: ProductionTask) {
  const warning = productionScheduleWarning(lot, task)
  if (warning) await warn(warning.type, warning.message, { lotId: lot.id, taskId: task.id }, lot.isDemo)
}

async function readScheduleWarnings(taskId: string, types: Array<'calendar' | 'bu'>) {
  await db.warnings.filter((warning) => warning.taskId === taskId && types.some((type) => type === warning.type)).modify({ read: true })
}

async function rescheduleProductionTask(task: ProductionTask, lot: CoffeeLot, allocations: LotAllocation[], settings: AppSettings) {
  const relevant = allocations.filter((item) => matchesTaskAllocation(task, item))
  if (!relevant.length) return
  const schedule = plannedTaskSchedule(lot, relevant, settings, scheduleDegassing)
  if (task.inBU) {
    schedule.buDate = task.buDate
    if (schedule.scheduleDecision === 'bu') schedule.scheduleDecision = 'move'
    if (schedule.plannedDate === task.plannedDate) return
  }
  if (schedule.readyDate === task.readyDate && schedule.plannedDate === task.plannedDate && schedule.buDate === task.buDate && schedule.scheduleDecision === task.scheduleDecision) return
  const approved = schedule.scheduleDecision === 'none'
  await db.productionTasks.update(task.id, { ...schedule, approved })
  await readScheduleWarnings(task.id, ['calendar', 'bu'])
  await warnAboutSchedule(lot, { ...task, ...schedule, approved })
}

export async function updateLotDegassing(lotId: string, days: number, allocationDays: Record<string, number | undefined>) {
  assertDegassingDays(days)
  await db.transaction('rw', allTables(), async () => {
    const lot = await db.lots.get(lotId)
    if (!lot) throw new Error('Лот не найден')
    const allocations = await db.allocations.where('lotId').equals(lotId).toArray()
    const tasks = await db.productionTasks.where('lotId').equals(lotId).toArray()
    const settings = await getSettings()
    const nextAllocations = allocations.map((item) => {
      const degassingDays = Object.hasOwn(allocationDays, item.id) ? allocationDays[item.id] : item.degassingDays
      if (degassingDays !== undefined) assertDegassingDays(degassingDays)
      return { ...item, degassingDays }
    })
    const changedAllocations = allocations.filter((item, index) =>
      (item.degassingDays ?? lot.degassingDays) !== (nextAllocations[index].degassingDays ?? days))
    const changedTasks = tasks.filter((task) => changedAllocations.some((item) => matchesTaskAllocation(task, item)))
    if (changedTasks.some((task) => task.status !== 'open' || task.producedQuantity > 0 || task.inBU)) throw new Error('Нельзя изменить срок назначения после изготовления или упаковки в Б/у')
    const updated = { ...lot, degassingDays: days }
    await db.lots.put(updated)
    await db.allocations.bulkPut(nextAllocations)
    for (const task of changedTasks) {
      await rescheduleProductionTask(task, updated, nextAllocations, settings)
    }
    await audit('schedule', 'lot', lot.id, `Изменён срок дегазации: ${lot.country} / ${lot.name}`, lot.isDemo)
  })
}

export async function updateProductionCalendar(change: CalendarSource | { day: string; mode: 'working' | 'closed' | 'default' }) {
  await db.transaction('rw', allTables(), async () => {
    const settings = { ...await getSettings() }
    if ('day' in change) {
      const { day, mode } = change
      if (!isCalendarDate(day)) throw new Error('Укажите корректную дату')
      settings.nonWorkingDays = settings.nonWorkingDays.filter((item) => item !== day)
      settings.workingOverrides = settings.workingOverrides.filter((item) => item !== day)
      if (mode === 'working') settings.workingOverrides.push(day)
      if (mode === 'closed') settings.nonWorkingDays.push(day)
    } else {
      settings.calendarSource = parseCalendarSource(change)
    }
    await updateSettings(settings)
    const tasks = await db.productionTasks.where('status').equals('open').filter((task) => task.producedQuantity === 0).toArray()
    const lotIds = [...new Set(tasks.map((task) => task.lotId))]
    const lots = new Map((await db.lots.bulkGet(lotIds)).flatMap((lot) => lot ? [[lot.id, lot] as const] : []))
    const allocations = new Map<string, LotAllocation[]>()
    for (const item of await db.allocations.where('lotId').anyOf(lotIds).toArray()) {
      const items = allocations.get(item.lotId)
      if (items) items.push(item)
      else allocations.set(item.lotId, [item])
    }
    for (const task of tasks) {
      const lot = lots.get(task.lotId)
      if (lot) await rescheduleProductionTask(task, lot, allocations.get(lot.id) ?? [], settings)
    }
  })
}

export async function approveSchedule(taskId: string) {
  await db.transaction('rw', allTables(), async () => {
    const task = await db.productionTasks.get(taskId)
    if (!task || task.status !== 'open') throw new Error('Задача недоступна')
    if (task.approved) return
    await db.productionTasks.update(taskId, { approved: true })
    if (task.scheduleDecision === 'move') await readScheduleWarnings(taskId, ['calendar'])
    await audit('approve', 'production', taskId, task.scheduleDecision === 'bu' ? 'Упаковка в Б/у согласована' : 'Производственная дата подтверждена администратором', task.isDemo)
  })
}

export async function markBU(taskId: string) {
  await db.transaction('rw', allTables(), async () => {
    const task = await db.productionTasks.get(taskId)
    if (!task || task.status !== 'open' || task.scheduleDecision !== 'bu') throw new Error('Задача упаковки в Б/у недоступна')
    if (!task.approved) throw new Error('Сначала подтвердите упаковку в Б/у')
    if (task.inBU) return
    await db.productionTasks.update(taskId, { inBU: true })
    await readScheduleWarnings(taskId, ['bu'])
    await audit('update', 'production', taskId, 'Выполнена операция «Запаковать в Б/у»', task.isDemo)
  })
}

export async function produce(taskId: string, quantity: number, responsibleId: string, comment = '', isDemo = false) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Количество должно быть целым положительным числом')
  return db.transaction('rw', allTables(), async () => {
    const task = await db.productionTasks.get(taskId)
    if (!task || task.status !== 'open') throw new Error('Задача недоступна')
    if (!task.approved) throw new Error('Сначала подтвердите производственную дату')
    if (task.scheduleDecision === 'bu' && !task.inBU) throw new Error('Сначала отметьте, что кофе запакован в Б/у')
    const employee = await db.employees.get(responsibleId)
    if (!employee?.active) throw new Error('Выберите активного ответственного')
    const lot = await db.lots.get(task.lotId)
    const settings = await getSettings()
    const format = settings.formats.find((item) => item.id === task.formatId)
    if (!lot || !format) throw new Error('Данные лота или формата повреждены')

    const producedQuantity = task.producedQuantity + quantity
    if (!Number.isSafeInteger(producedQuantity)) throw new Error('Слишком большое количество продукции')
    const createdAt = new Date().toISOString()
    const demo = isDemo || task.isDemo
    const previousEntries = await db.productionEntries.where('taskId').equals(taskId).toArray()
    const relevant = await db.allocations.where('lotId').equals(lot.id).filter((item) => matchesTaskAllocation(task, item)).toArray()
    const coefficientSnapshot = task.coefficientSnapshot ?? previousEntries[0]?.coefficientSnapshot ?? format.coefficient
    const purposeQuantities = task.purpose === undefined
      ? splitProductionReceipt(quantity, relevant, coefficientSnapshot, task.producedQuantity, previousEntries)
      : { [task.purpose]: quantity }
    const entry: ProductionEntry = { id: uid(), taskId, lotId: lot.id, quantity, responsibleId, coefficientSnapshot: format.coefficient, purposeQuantities, createdAt, comment, isDemo: demo }
    await db.productionEntries.add(entry)
    for (const [purpose, part] of Object.entries(purposeQuantities)) {
      const inventoryLot: InventoryLot = { id: uid(), sourceLotId: lot.id, productionTaskId: taskId, productionEntryId: entry.id, country: lot.country, coffeeName: lot.name, formatId: task.formatId, purpose, shared: !isPrivateLabel(purpose), quantity: part, reserved: 0, manufacturedAt: createdAt, createdAt, inBU: task.inBU, isDemo: demo }
      await db.inventory.add(inventoryLot)
      await db.inventoryTransactions.add({ id: uid(), inventoryLotId: inventoryLot.id, type: 'receipt', quantity: part, previousQuantity: 0, newQuantity: part, author: `${employee.lastName} ${employee.firstName}`, createdAt, isDemo: demo })
      await settleExpectedReservations(inventoryLot)
    }
    const entries = [...previousEntries, entry]
    const changed = { ...task, producedQuantity, coefficientSnapshot, responsibleId }
    const remainder = remainingCoffee(changed, format, entries)
    const status: ProductionTask['status'] = producedQuantity >= task.plannedQuantity || remainder <= 1e-9 ? 'completed' : 'open'
    await db.productionTasks.update(taskId, { producedQuantity, coefficientSnapshot, status, responsibleId })
    if (coffeeDiscrepancy(changed, format, entries)) await warn('discrepancy', `${lot.country} / ${lot.name}: фактический расход превысил расчётный остаток`, { lotId: lot.id, taskId }, demo)
    await audit('produce', 'production', taskId, `Изготовлено ${quantity} шт. (${format.name})`, demo)
    return { task: { ...changed, status }, remainder, received: quantity }
  })
}

export async function writeOffProduction(taskId: string, weightKg: number, reason: string) {
  if (!Number.isFinite(weightKg) || weightKg <= 0 || !reason.trim()) throw new Error('Укажите положительный вес и причину списания')
  await db.transaction('rw', allTables(), async () => {
    const task = await db.productionTasks.get(taskId)
    if (!task || task.status === 'cancelled') throw new Error('Задача не найдена или отменена')
    const settings = await getSettings()
    const format = settings.formats.find((item) => item.id === task.formatId)
    if (!format) throw new Error('Формат задачи не найден')
    const entries = await db.productionEntries.where('taskId').equals(taskId).toArray()
    const remaining = remainingCoffee(task, format, entries)
    if (weightKg > remaining + 1e-9) throw new Error('Нельзя списать больше расчётного остатка')
    const deduction = Math.min(weightKg, remaining)
    if (deduction <= 0) throw new Error('Остаток кофе уже исчерпан')
    const writtenOffKg = task.writtenOffKg + deduction
    const nextRemaining = remainingCoffee({ ...task, writtenOffKg }, format, entries)
    const claims = await db.expectedReservations.where('productionTaskId').equals(taskId).toArray()
    if (claims.length) {
      const allocations = await db.allocations.where('lotId').equals(task.lotId).toArray()
      if (!fitsExpectedReservations({ ...task, writtenOffKg }, settings, allocations, entries, claims)) {
        throw new Error('После списания выпуска не хватит на подтверждённый резерв сборки')
      }
    }
    const status = nextRemaining <= 1e-9 ? 'completed' : task.status
    await db.productionTasks.update(taskId, { writtenOffKg, status })
    await db.adjustments.add({ id: uid(), entityType: 'production', entityId: task.id, previousValue: remaining, newValue: nextRemaining, reason: reason.trim(), createdAt: new Date().toISOString(), isDemo: task.isDemo })
    await audit('writeoff', 'production', taskId, `Списано ${deduction} кг: ${reason.trim()}`, task.isDemo)
  })
}

export async function adjustInventory(inventoryLotId: string, newQuantity: number, reason: string, comment = '', expectedQuantity?: number, operation: 'adjust' | 'writeoff' = 'adjust') {
  if (!Number.isSafeInteger(newQuantity) || newQuantity < 0 || !reason.trim()) throw new Error('Укажите неотрицательное целое количество и причину')
  await db.transaction('rw', allTables(), async () => {
    const lot = await db.inventory.get(inventoryLotId)
    if (!lot) throw new Error('Позиция стока не найдена')
    if (expectedQuantity !== undefined && lot.quantity !== expectedQuantity) throw new Error('Остаток изменился. Проверьте текущее количество перед корректировкой')
    if (newQuantity < lot.reserved) throw new Error('Количество меньше активного резерва')
    if (newQuantity === lot.quantity) throw new Error('Количество не изменилось')
    if (operation === 'writeoff' && newQuantity > lot.quantity) throw new Error('При списании количество должно уменьшаться')
    await db.inventory.update(inventoryLotId, { quantity: newQuantity })
    await db.inventoryTransactions.add({ id: uid(), inventoryLotId, type: operation, quantity: newQuantity - lot.quantity, previousQuantity: lot.quantity, newQuantity, reason, comment, author: 'Администратор', createdAt: new Date().toISOString(), isDemo: lot.isDemo })
    await db.adjustments.add({ id: uid(), entityType: 'inventory', entityId: inventoryLotId, previousValue: lot.quantity, newValue: newQuantity, reason, comment, createdAt: new Date().toISOString(), isDemo: lot.isDemo })
    await warn('adjustment', `${lot.country} / ${lot.coffeeName}: остаток изменён с ${lot.quantity} до ${newQuantity}`, { lotId: lot.sourceLotId }, lot.isDemo)
    await audit(operation, 'inventory', inventoryLotId, `Корректировка: ${lot.quantity} → ${newQuantity}`, lot.isDemo)
  })
}

export async function reassignInventory(inventoryLotId: string, purpose: string, quantity: number) {
  if (!purpose.trim() || !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Укажите назначение и положительное количество')
  await db.transaction('rw', allTables(), async () => {
    const lot = await db.inventory.get(inventoryLotId)
    if (!lot || quantity > available(lot)) throw new Error('Недостаточно доступного остатка')
    const settings = await getSettings()
    if (!purposesForFormat(lot.formatId, settings.purposes).includes(purpose.trim())) throw new Error('Назначение недоступно для этого формата')
    if (isPrivateLabel(lot.purpose)) throw new Error('Сток СТМ хранится отдельно и не переназначается')
    if (lot.purpose === purpose.trim()) throw new Error('Назначение не изменилось')
    await recordReassignment(lot, purpose.trim(), quantity)
  })
}

async function recordReassignment(lot: InventoryLot, purpose: string, quantity: number, taskId?: string): Promise<InventoryLot> {
  if (quantity > available(lot)) throw new Error('Недостаточно доступного остатка для переназначения')
  const entireLot = quantity === lot.quantity
  const destination = entireLot ? { ...lot, purpose } : { ...lot, id: uid(), purpose, quantity, reserved: 0 }
  const newQuantity = entireLot ? lot.quantity : lot.quantity - quantity
  const reason = `${lot.purpose} → ${purpose}`
  const event = {
    type: 'reassign' as const, reason, fromPurpose: lot.purpose, toPurpose: purpose, assemblyTaskId: taskId,
    author: 'Администратор', createdAt: new Date().toISOString(), isDemo: lot.isDemo,
  }
  await db.inventory.update(lot.id, entireLot ? { purpose } : { quantity: newQuantity })
  await db.inventoryTransactions.add({
    ...event, id: uid(), inventoryLotId: lot.id, quantity: entireLot ? 0 : -quantity,
    previousQuantity: lot.quantity, newQuantity, relatedInventoryLotId: entireLot ? undefined : destination.id,
  })
  if (!entireLot) {
    await db.inventory.add(destination)
    await db.inventoryTransactions.add({
      ...event, id: uid(), inventoryLotId: destination.id, quantity, previousQuantity: 0,
      newQuantity: quantity, relatedInventoryLotId: lot.id,
    })
  }
  await audit('reassign', 'inventory', lot.id, `Переназначено ${quantity} шт. (${reason})`, lot.isDemo)
  if (taskId) await warn('reassign', `${lot.country} / ${lot.coffeeName}: ${quantity} шт. переназначено (${reason})`, { lotId: lot.sourceLotId, taskId }, lot.isDemo)
  return destination
}

export async function createAssemblyPlan(entries: Array<{ composition: ManualComposition | ImportedComposition; quantity: number; comment?: string; jointAssembly?: boolean }>, date = today(), isDemo = false, replacePlanId?: string) {
  if (!isCalendarDate(date)) throw new Error('Укажите корректную дату плана')
  if (!entries.length) throw new Error('Добавьте хотя бы один состав в план')
  if (entries.some((entry) => !Number.isSafeInteger(entry.quantity) || entry.quantity <= 0)) throw new Error('Количество наборов должно быть целым положительным числом')
  const planId = replacePlanId ?? uid()
  await db.transaction('rw', allTables(), async () => {
    const closedDay = await db.productionDays.where('date').equals(date).filter(({ status }) => status === 'closed').first()
    const productionDate = closedDay?.nextWorkingDate ?? date
    if (replacePlanId) {
      const plan = await db.assemblyPlans.get(replacePlanId)
      if (plan?.status !== 'draft') throw new Error('Только черновик можно пересчитать')
      await db.assemblyTasks.where('planId').equals(planId).filter(({ status }) => status === 'pending').modify({ status: 'cancelled' })
      await db.assemblyPlans.update(planId, { date: productionDate })
    } else {
      await db.assemblyPlans.add({ id: planId, date: productionDate, status: 'draft', createdAt: new Date().toISOString(), isDemo })
    }
    for (const entry of entries) {
      const table = 'sheetConnectionId' in entry.composition ? db.importedCompositions : db.manualCompositions
      const composition = await table.get(entry.composition.id)
      if (!composition?.enabled || ('removed' in composition && composition.removed)) throw new Error(`Состав «${entry.composition.name}» отключён или обновился. Добавьте актуальный состав`)
      await db.assemblyTasks.add({ id: uid(), planId, compositionId: composition.id, compositionKind: composition.kind, compositionSnapshot: composition.items, jointAssembly: entry.jointAssembly, name: composition.name, plannedQuantity: entry.quantity, completedQuantity: 0, status: 'pending', productionDate, comment: entry.comment?.trim(), createdAt: new Date().toISOString(), isDemo: isDemo || Boolean(composition.isDemo) })
    }
    await audit(replacePlanId ? 'update' : 'create', 'assembly', planId, `План сборки: ${entries.length} заданий`, isDemo)
  })
  return planId
}

function itemMatchesLot(item: CompositionItem, lot: InventoryLot): boolean {
  if (item.formatId !== lot.formatId) return false
  return item.inventoryLotId ? item.inventoryLotId === lot.sourceLotId : coffeeKey(item.country, item.coffeeName) === coffeeKey(lot.country, lot.coffeeName)
}

class ReservationPlanError extends Error {
  readonly warning: 'unmatched' | 'shortage' | 'reassign'
  readonly taskId?: string

  constructor(warning: ReservationPlanError['warning'], message: string, taskId?: string) {
    super(message)
    this.warning = warning
    this.taskId = taskId
  }
}

export async function confirmAssemblyPlan(planId: string, approvedMoves?: string, approvedExpected?: string) {
  try {
    await db.transaction('rw', allTables(), async () => {
      const plan = await db.assemblyPlans.get(planId)
      const tasks = await db.assemblyTasks.where('planId').equals(planId).filter(({ status }) => status !== 'cancelled').toArray()
      if (!plan || plan.status !== 'draft' || !tasks.length || tasks.some(({ status, compositionSnapshot }) => status !== 'pending' || !compositionSnapshot.length)) throw new Error('План уже подтверждён или пуст')
      for (const task of tasks) {
        const composition = task.compositionKind === 'x16' || task.compositionKind === 'x30'
          ? await db.importedCompositions.get(task.compositionId)
          : await db.manualCompositions.get(task.compositionId)
        if (!composition?.enabled || ('removed' in composition && composition.removed) || composition.kind !== task.compositionKind || composition.name !== task.name ||
          JSON.stringify(composition.items.map(stockIdentity)) !== JSON.stringify(task.compositionSnapshot.map(stockIdentity))) {
          throw new Error(`Состав «${task.name}» изменился или отключён. Пересчитайте план`)
        }
      }
      const taskIndex = new Map(tasks.map((task) => [task.id, task]))
      const day = today()
      const [lots, allocations, productionTasks, productionEntries, expectedReservations, productionDays, inventory, settings] = await Promise.all([
        db.lots.toArray(), db.allocations.toArray(), db.productionTasks.toArray(), db.productionEntries.toArray(),
        db.expectedReservations.toArray(), db.productionDays.toArray(), db.inventory.toArray(), getSettings(),
      ])
      const closed = productionDays.find(({ date, status }) => date === plan.date && status === 'closed')
      const date = closed?.nextWorkingDate ?? plan.date
      const preview = previewAssemblyReservation(tasks, { lots, allocations, productionTasks, productionEntries, expectedReservations, productionDays, inventory, settings }, date, day)
      const issue = preview.shortages[0]
      if (issue) throw new ReservationPlanError(issue.reason === 'unmatched' || issue.reason === 'ambiguous' ? 'unmatched' : 'shortage', describeShortage(issue), issue.demand.taskId)
      if (preview.expected.length) {
        if (!hasAdminSession()) throw new Error('Резерв под ожидаемый выпуск может подтвердить только администратор')
        if (preview.approvalKey !== approvedExpected) throw new Error('Проверьте и подтвердите актуальное покрытие ожидаемым выпуском')
      }
      if (preview.physical.moves.length && preview.physical.approvalKey !== approvedMoves) {
        throw new ReservationPlanError('reassign', 'Проверьте и подтвердите использование остатков другого назначения', preview.physical.moves[0].demand.taskId)
      }
      const createdAt = new Date().toISOString()
      for (const { demand, lot, quantity } of preview.physical.allocations) {
        const task = demand.taskId && taskIndex.get(demand.taskId)
        const current = await db.inventory.get(lot.id)
        if (!task || !current || quantity > available(current)) throw new Error('Сток изменился. Пересчитайте план')
        const stock = demand.purpose && needsStockReassignment(demand, current) ? await recordReassignment(current, demand.purpose, quantity, task.id) : current
        await reserveInventory(stock, task, demand.item.id, quantity, createdAt)
      }
      for (const { demand, lot, quantity } of preview.expected) {
        const task = demand.taskId && taskIndex.get(demand.taskId)
        if (!task) throw new Error('Задание сборки не найдено')
        await db.expectedReservations.add({
          id: uid(), assemblyTaskId: task.id, compositionItemId: demand.item.id, productionTaskId: lot.productionTaskId,
          purpose: lot.purpose, quantity, reported: [], createdAt, isDemo: task.isDemo,
        })
      }
      for (const task of tasks) await db.assemblyTasks.update(task.id, { status: 'confirmed', productionDate: date })
      await db.assemblyPlans.update(planId, { status: 'confirmed', date })
      await audit('confirm', 'assembly', planId, preview.expected.length ? 'План подтверждён под ожидаемый выпуск' : 'План подтверждён, сток зарезервирован', plan.isDemo)
    })
  } catch (error) {
    if (error instanceof ReservationPlanError) {
      await db.transaction('rw', db.warnings, async () => {
        const known = await db.warnings.filter((item) => !item.read && item.type === error.warning && item.taskId === error.taskId && item.message === error.message).first()
        if (!known) await warn(error.warning, error.message, { taskId: error.taskId })
      })
    }
    throw error
  }
}

function stockIdentity(item: CompositionItem) {
  return [item.id, item.country, item.coffeeName, item.formatId, item.quantityPerSet, item.inventoryLotId]
}

async function consumeReport(task: AssemblyTask, quantity: number, report: Parameters<typeof consumeReservedInventory>[2]) {
  const deductions: import('@/domain/types').DeductionDetail[] = []
  const items = [...task.compositionSnapshot].sort((a, b) => Number(Boolean(b.inventoryLotId)) - Number(Boolean(a.inventoryLotId)))
  for (const item of items) {
    let needed = item.quantityPerSet * quantity
    const reservations = (await db.reservations.where('assemblyTaskId').equals(task.id).toArray()).filter((reservation) => reservation.status === 'active')
    const pairs = []
    for (const reservation of reservations) {
      const lot = await db.inventory.get(reservation.inventoryLotId)
      if (lot && (reservation.compositionItemId ? reservation.compositionItemId === item.id : itemMatchesLot(item, lot))) pairs.push({ reservation, lot })
    }
    pairs.sort((a, b) => compareStockFifo(a.lot, b.lot) || a.reservation.id.localeCompare(b.reservation.id))
    for (const { reservation } of pairs) {
      const left = reservation.quantity - reservation.consumedQuantity
      const amount = Math.min(needed, left)
      if (amount <= 0) continue
      deductions.push(await consumeReservedInventory(reservation, amount, report))
      needed -= amount
      if (needed === 0) break
    }
    if (needed > 0) needed = await reportAgainstExpected(task.id, item.id, report.id, needed)
    if (needed > 0) throw new Error(`Не хватает резерва для списания ${needed} шт.`)
  }
  return deductions
}

export async function correctAssemblyReport(reportId: string, newQuantity: number, correctionComment: string) {
  if (!Number.isSafeInteger(newQuantity) || newQuantity < 0 || !correctionComment.trim()) throw new Error('Укажите неотрицательное целое количество и комментарий исправления')
  await db.transaction('rw', allTables(), async () => {
    const report = await db.assemblyReports.get(reportId)
    if (!report) throw new Error('Отчёт не найден')
    const task = await db.assemblyTasks.get(report.taskId)
    if (!task) throw new Error('Задание не найдено')
    const delta = newQuantity - report.quantity
    if (delta === 0) throw new Error('Количество не изменилось')
    if (delta > 0 && delta > task.plannedQuantity - task.completedQuantity) throw new Error('Исправление превышает остаток задания')
    const cancelled = task.status === 'cancelled'
    if (delta > 0 && cancelled) throw new Error('У отменённого задания освобождён резерв. Создайте новый план на дополнительное количество')
    let deductions = [...report.deductions]
    if (delta > 0) {
      deductions = [...deductions, ...await consumeReport(task, delta, { id: report.id, author: 'Администратор', reason: correctionComment, isDemo: report.isDemo })]
    } else {
      const deductionsToRestore = report.deductions.map((item) => ({ ...item }))
      const items = [...task.compositionSnapshot].sort((a, b) => Number(Boolean(b.inventoryLotId)) - Number(Boolean(a.inventoryLotId)))
      for (const item of items) {
        let needed = await restoreExpectedDeduction(task, item.id, report.id, item.quantityPerSet * -delta)
        if (!needed) continue
        for (const deduction of [...deductionsToRestore].reverse()) {
          const lot = await db.inventory.get(deduction.inventoryLotId)
          const reservation = await db.reservations.get(deduction.reservationId)
          if (!lot || !reservation) continue
          if (reservation.compositionItemId ? reservation.compositionItemId !== item.id : !itemMatchesLot(item, lot)) continue
          const amount = Math.min(needed, deduction.quantity)
          if (amount <= 0) continue
          if (amount > reservation.consumedQuantity) throw new Error('История резерва повреждена')
          const reserved = lot.reserved + (cancelled ? 0 : amount)
          await db.inventory.update(lot.id, { quantity: lot.quantity + amount, reserved })
          await db.reservations.update(reservation.id, { consumedQuantity: reservation.consumedQuantity - amount, status: cancelled ? 'released' : 'active' })
          await db.inventoryTransactions.add({ id: uid(), inventoryLotId: lot.id, type: 'adjust', quantity: amount, previousQuantity: lot.quantity, newQuantity: lot.quantity + amount, previousReserved: lot.reserved, newReserved: reserved, assemblyTaskId: task.id, reportId, reason: correctionComment, author: 'Администратор', createdAt: new Date().toISOString(), isDemo: report.isDemo })
          deduction.quantity -= amount
          needed -= amount
          if (needed === 0) break
        }
        if (needed > 0) throw new Error('Не удалось восстановить резерв по детализации отчёта')
      }
      deductions = deductionsToRestore.filter((item) => item.quantity > 0)
    }
    const correctedAt = new Date().toISOString()
    await db.assemblyReports.update(reportId, { quantity: newQuantity, originalQuantity: report.originalQuantity ?? report.previousQuantity ?? report.quantity, previousQuantity: report.quantity, correctionComment, correctedAt, deductions })
    const completedQuantity = task.completedQuantity + delta
    const shift = await db.productionDays.where('date').equals(task.productionDate).filter(({ status }) => status === 'closed').first()
    const currentDate = today()
    let productionDate = shift ? shift.nextWorkingDate ?? nextShiftDate(shift.date, await getSettings()) : task.productionDate
    if (shift && productionDate < currentDate) productionDate = currentDate
    const currentShift = await db.productionDays.where('date').equals(currentDate).filter(({ status }) => status === 'closed').first()
    if (currentShift && productionDate <= currentDate) productionDate = currentShift.nextWorkingDate ?? nextShiftDate(currentDate, await getSettings())
    const status = cancelled ? 'cancelled' : completedQuantity === task.plannedQuantity ? 'completed' : productionDate > currentDate ? 'transferred' : completedQuantity === 0 ? 'confirmed' : 'partial'
    await db.assemblyTasks.update(task.id, { completedQuantity, status, ...(!cancelled && status !== 'completed' ? { productionDate } : {}) })
    await db.adjustments.add({ id: uid(), entityType: 'report', entityId: reportId, previousValue: report.quantity, newValue: newQuantity, reason: correctionComment, createdAt: correctedAt, isDemo: report.isDemo })
    const reason = `Отчёт «${task.name}» исправлен: ${report.quantity} → ${newQuantity}. ${correctionComment}`
    await warn('adjustment', reason, { taskId: task.id, reportId }, report.isDemo)
    await audit('correct', 'report', reportId, reason, report.isDemo)
    await db.dailyReports.where('date').aboveOrEqual(report.productionDate).modify((daily) => {
      const snapshot = daily.assembled.find(({ taskId }) => taskId === task.id)
      if (!snapshot) return
      snapshot.remaining = Math.max(0, snapshot.remaining - delta)
      if (daily.date === report.productionDate) {
        snapshot.fact += delta
        snapshot.comments.push(reason)
      } else {
        snapshot.plan = Math.max(snapshot.fact, snapshot.plan - delta)
      }
    })
  })
}

async function recordAssemblyFact(task: AssemblyTask, date: string, participantIds: string[], quantity: number, comment: string, isDemo: boolean) {
  if (new Set(participantIds).size !== participantIds.length || (task.jointAssembly ? participantIds.length < 2 : participantIds.length !== 1)) {
    throw new Error(task.jointAssembly ? 'Выберите минимум двух разных участников' : 'Выберите одного сборщика')
  }
  const employees = await db.employees.bulkGet(participantIds)
  if (employees.some((employee) => !employee?.active)) throw new Error('Выберите активных сотрудников')
  if (task.jointAssembly && await db.assemblyReports.where('taskId').equals(task.id).filter((report) => report.productionDate === date).first()) {
    throw new Error('Совместный отчёт за эту смену уже отправлен')
  }
  const remaining = task.plannedQuantity - task.completedQuantity
  if (quantity > remaining) throw new Error(`Осталось только ${remaining} наборов`)
  const id = uid()
  const report = {
    id, taskId: task.id, employeeId: participantIds[0], participantIds, quantity, originalQuantity: quantity,
    createdAt: new Date().toISOString(), comment: comment.trim(), productionDate: date, isDemo,
  }
  const author = assemblyParticipantNames(report, employees.filter((employee) => employee !== undefined)).join(', ')
  const deductions = await consumeReport(task, quantity, { id, author, isDemo })
  await db.assemblyReports.add({ ...report, deductions })
  const completedQuantity = task.completedQuantity + quantity
  await db.assemblyTasks.update(task.id, { completedQuantity, status: completedQuantity === task.plannedQuantity ? 'completed' : 'partial' })
  await audit('report', 'assembly', task.id, `Отчёт: ${quantity} наборов`, isDemo)
}

export async function reportAssembly(taskId: string, participants: string | string[], quantity: number, comment = '', isDemo = false) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Введите целое положительное количество')
  await db.transaction('rw', allTables(), async () => {
    const task = await db.assemblyTasks.get(taskId)
    if (!task || !['confirmed', 'partial', 'transferred'].includes(task.status)) throw new Error('Задание недоступно для отчёта')
    const date = today()
    if (task.productionDate > date) throw new Error(`Следующая смена по этому заданию: ${task.productionDate}`)
    if (await db.productionDays.where('date').equals(date).filter(({ status }) => status === 'closed').first()) throw new Error('Производственный день уже закрыт')
    await recordAssemblyFact(task, date, typeof participants === 'string' ? [participants] : participants, quantity, comment, isDemo || Boolean(task.isDemo))
  })
}

export async function warnAdmin(taskId: string, message: string) {
  if (!message.trim()) throw new Error('Напишите сообщение администратору')
  await db.transaction('rw', [db.assemblyTasks, db.warnings], async () => {
    const task = await db.assemblyTasks.get(taskId)
    if (!task || !['confirmed', 'partial', 'transferred'].includes(task.status)) throw new Error('Задание недоступно')
    await warn('employee', message.trim(), { taskId }, task.isDemo)
  })
}

export async function cancelAssemblyTask(taskId: string, reason: string) {
  if (!reason.trim()) throw new Error('Укажите причину отмены')
  await db.transaction('rw', allTables(), async () => {
    const task = await db.assemblyTasks.get(taskId)
    if (!task || ['completed', 'cancelled'].includes(task.status)) throw new Error('Задание уже завершено или отменено')
    const reservations = await db.reservations.where('assemblyTaskId').equals(taskId).toArray()
    for (const reservation of reservations.filter((item) => item.status === 'active')) {
      const lot = await db.inventory.get(reservation.inventoryLotId)
      const amount = reservation.quantity - reservation.consumedQuantity
      if (!lot || lot.reserved < amount) throw new Error('Резерв повреждён: операция отменена')
      const reserved = lot.reserved - amount
      await db.inventory.update(lot.id, { reserved })
      await db.reservations.update(reservation.id, { status: 'released' })
      await db.inventoryTransactions.add({ id: uid(), inventoryLotId: lot.id, type: 'release', quantity: amount, previousQuantity: lot.quantity, newQuantity: lot.quantity, previousReserved: lot.reserved, newReserved: reserved, assemblyTaskId: taskId, reason, author: 'Администратор', createdAt: new Date().toISOString(), isDemo: task.isDemo })
    }
    await releaseExpectedReservations(taskId)
    await db.assemblyTasks.update(taskId, { status: 'cancelled' })
    await audit('cancel', 'assembly', taskId, `Задание отменено: ${reason}`, task.isDemo)
  })
}

export function tasksToTransfer(tasks: AssemblyTask[], date: string) {
  return tasks.filter((task) => task.productionDate <= date && ['confirmed', 'partial', 'transferred'].includes(task.status) && task.completedQuantity < task.plannedQuantity)
}

export function summarizeAssembly(tasks: AssemblyTask[], reports: AssemblyReport[], employees: Employee[], date: string): DailyReport['assembled'] {
  const openIds = new Set(tasksToTransfer(tasks, date).map((task) => task.id))
  return tasks.flatMap((task) => {
    const own = reports.filter((report) => report.taskId === task.id)
    if (!own.length && !openIds.has(task.id)) return []
    const names = own.flatMap((report) => assemblyParticipantNames(report, employees))
    const fact = own.reduce((sum, report) => sum + report.quantity, 0)
    const remaining = task.plannedQuantity - task.completedQuantity
    return [{
      taskId: task.id, name: task.name, plan: fact + remaining, fact, remaining,
      employees: [...new Set(names)],
      comments: own.flatMap((report) => [report.comment, report.correctionComment]).filter((comment): comment is string => Boolean(comment)),
    }]
  })
}

export async function closeProductionDay(date = today()) {
  if (!isCalendarDate(date)) throw new Error('Укажите корректную дату смены')
  await db.transaction('rw', allTables(), async () => {
    if (await db.dailyReports.where('date').equals(date).first()) throw new Error('Этот день уже завершён')
    const existing = await db.productionDays.where('date').equals(date).first()
    if (existing?.status === 'closed') throw new Error('Этот день уже завершён')
    const settings = await getSettings()
    const entries = (await db.productionEntries.toArray()).filter((entry) => format(parseISO(entry.createdAt), 'yyyy-MM-dd') === date)
    const reports = (await db.assemblyReports.toArray()).filter((report) => report.productionDate === date)
    const tasks = await db.assemblyTasks.toArray()
    const employees = await db.employees.toArray()
    const next = nextShiftDate(date, settings)
    for (const task of tasksToTransfer(tasks, date)) {
      await db.assemblyTasks.update(task.id, { status: 'transferred', productionDate: next })
      await warn('unfinished', `«${task.name}»: остаток ${task.plannedQuantity - task.completedQuantity} перенесён на ${next}`, { taskId: task.id }, task.isDemo)
    }
    const assembled = summarizeAssembly(tasks, reports, employees, date)
    const warnings = await db.warnings.filter((item) => !item.read || format(parseISO(item.createdAt), 'yyyy-MM-dd') === date).toArray()
    await db.dailyReports.add({ id: uid(), date, produced: entries, assembled, warnings, createdAt: new Date().toISOString() })
    await db.productionDays.put({ id: existing?.id ?? uid(), date, status: 'closed', closedAt: new Date().toISOString(), nextWorkingDate: next })
    await audit('close', 'day', date, `Производственный день ${date} завершён`)
  })
}

function referencesDemo(value: unknown, demoIds: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => referencesDemo(item, demoIds))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, field]) => {
    if (key.endsWith('Id') && typeof field === 'string') return demoIds.has(field)
    return referencesDemo(field, demoIds)
  })
}

export async function clearDemoData() {
  await db.transaction('rw', allTables(), async () => {
    const names = tableNames.filter((name) => name !== 'settings')
    const tables = await Promise.all(names.map(async (name) => ({
      name,
      rows: await db.table<{ id: string; isDemo?: boolean }, string>(name).toArray(),
    })))
    const demoIds = new Set(tables.flatMap(({ rows }) => rows.filter((row) => row.isDemo).map((row) => row.id)))
    const tasks = await db.assemblyTasks.toArray()
    const plansWithDemo = new Set(tasks.filter((task) => task.isDemo).map((task) => task.planId))
    for (const task of tasks) if (!task.isDemo) plansWithDemo.delete(task.planId)
    for (const id of plansWithDemo) demoIds.add(id)
    const journalTables = new Set<string>(['adjustments', 'auditEvents', 'warnings'])
    for (const { name, rows } of tables) {
      if (journalTables.has(name) || name === 'dailyReports') continue
      if (rows.some((row) => !demoIds.has(row.id) && referencesDemo(row, demoIds))) {
        throw new Error('Демо используется в рабочих операциях. Очистка прервана, чтобы сохранить связанные данные.')
      }
    }
    await db.dailyReports.toCollection().modify((report) => {
      report.produced = report.produced.filter((entry) => !demoIds.has(entry.id) && !referencesDemo(entry, demoIds))
      report.assembled = report.assembled.filter((entry) => !demoIds.has(entry.taskId))
      report.warnings = report.warnings.filter((entry) => !demoIds.has(entry.id) && !referencesDemo(entry, demoIds))
    })
    for (const { name, rows } of tables) {
      const ids = rows.filter((row) => demoIds.has(row.id)
        || (journalTables.has(name) && referencesDemo(row, demoIds))).map((row) => row.id)
      if (ids.length) await db.table(name).bulkDelete(ids)
    }
  })
}

export async function seedDemoData() {
  await db.transaction('rw', allTables(), async () => {
    if ((await db.lots.filter((lot) => Boolean(lot.isDemo)).count()) > 0) throw new Error('Демонстрационные данные уже добавлены')
    const employees = await db.employees.toArray()
    async function demoEmployee(firstName: string, lastName: string) {
      let candidate = lastName
      let suffix = 1
      while (employees.some((item) => normalizeCoffeeName(item.firstName) === normalizeCoffeeName(firstName)
        && normalizeCoffeeName(item.lastName) === normalizeCoffeeName(candidate))) {
        candidate = `${lastName} (демо ${suffix++})`
      }
      return addEmployee(firstName, candidate, true)
    }
    const first = await demoEmployee('Анна', 'Иванова')
    await demoEmployee('Мария', 'Петрова')
    const coffees = [['Эфиопия', 'Гуджи'], ['Колумбия', 'Уила'], ['Бразилия', 'Серрадо'], ['Кения', 'Ньери']]
    const roastDate = format(addDays(new Date(), -7), 'yyyy-MM-dd')
    const coefficient = (await getSettings()).formats.find((format) => format.id === 'drip')?.coefficient ?? 0.0121
    const weightKg = Math.max(2.5, coefficient * 100)
    const items: CompositionItem[] = []
    for (const [country, name] of coffees) {
      const lot = await createLot({ country, name, roastDate, weightKg, degassingDays: 3, responsibleId: first.id, allocations: [{ formatId: 'drip', purpose: '×16', weightKg }] }, true)
      const task = await db.productionTasks.where('lotId').equals(lot.id).first()
      if (!task) throw new Error('Не удалось создать демонстрационную задачу')
      if (!task.approved) await approveSchedule(task.id)
      if (task.scheduleDecision === 'bu') await markBU(task.id)
      await produce(task.id, task.plannedQuantity, first.id, 'Демонстрационное изготовление', true)
      items.push({ id: uid(), country, coffeeName: name, formatId: 'drip', quantityPerSet: 4, inventoryLotId: lot.id })
    }
    await db.importedCompositions.add({ id: uid(), sheetConnectionId: 'demo', sheetName: '×16', column: 1, name: 'Восточная коллекция ×16', kind: 'x16', items, enabled: true, metadata: { Источник: 'Демонстрационные данные' }, importedAt: new Date().toISOString(), isDemo: true })
  })
}
