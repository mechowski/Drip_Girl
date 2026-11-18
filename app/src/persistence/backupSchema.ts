import { z } from 'zod'

const id = z.string().trim().min(1)
const text = z.string()
const label = z.string().trim().min(1)
const date = z.iso.date()
const timestamp = z.iso.datetime({ offset: true })
const count = z.number().int().nonnegative()
const positiveCount = count.positive()
const weight = z.number().nonnegative()
const coefficient = z.number().positive()
const days = z.number().int().min(1).max(5)
const formatId = z.enum(['drip', 'mega', 'smol30', 'smol60'])
const base = { id, isDemo: z.boolean().optional() }
const created = { ...base, createdAt: timestamp }
const compositionItem = z.looseObject({ id, country: label, coffeeName: label, formatId, quantityPerSet: positiveCount, inventoryLotId: id.optional() })
const productionEntry = z.looseObject({ ...created, taskId: id, lotId: id, quantity: positiveCount, responsibleId: id, coefficientSnapshot: coefficient, comment: text.optional(), purposeQuantities: z.record(label, count).optional() })
const warning = z.looseObject({
  ...created,
  type: z.enum(['calendar', 'bu', 'unmatched', 'import', 'shortage', 'reassign', 'employee', 'adjustment', 'unfinished', 'discrepancy']),
  message: label, read: z.boolean(), lotId: id.optional(), taskId: id.optional(), reportId: id.optional(), compositionId: id.optional(),
})

export const rowSchemas = {
  lots: z.looseObject({ ...created, country: label, name: label, roastDate: date, weightKg: weight.positive(), degassingDays: days, responsibleId: id.optional(), comment: text.optional() }),
  allocations: z.looseObject({ ...base, lotId: id, formatId, purpose: label, weightKg: weight.positive(), degassingDays: days.optional(), comment: text.optional(), position: count.optional() }),
  productionTasks: z.looseObject({
    ...created, lotId: id, formatId, sourceWeightKg: weight.positive(), plannedQuantity: count, producedQuantity: count, writtenOffKg: weight,
    readyDate: date, plannedDate: date, buDate: date.optional(), actualDegassingDays: z.number().int(),
    scheduleDecision: z.enum(['none', 'move', 'bu']), approved: z.boolean(), inBU: z.boolean(),
    status: z.enum(['open', 'completed', 'cancelled']), responsibleId: id.optional(), comment: text.optional(), coefficientSnapshot: coefficient.optional(),
  }),
  productionEntries: productionEntry,
  inventory: z.looseObject({
    ...created, sourceLotId: id, productionTaskId: id.optional(), country: label, coffeeName: label, formatId, purpose: label,
    quantity: count, reserved: count, manufacturedAt: timestamp, inBU: z.boolean(),
  }).refine((row) => row.reserved <= row.quantity, { path: ['reserved'], message: 'Резерв превышает физический остаток' }),
  inventoryTransactions: z.looseObject({
    ...created, inventoryLotId: id, type: z.enum(['receipt', 'reserve', 'release', 'consume', 'adjust', 'writeoff', 'reassign']),
    quantity: z.number().int(), previousQuantity: count, newQuantity: count, previousReserved: count.optional(), newReserved: count.optional(),
    reason: text.optional(), comment: text.optional(), assemblyTaskId: id.optional(), reportId: id.optional(), author: label,
    fromPurpose: label.optional(), toPurpose: label.optional(), relatedInventoryLotId: id.optional(),
  }),
  reservations: z.looseObject({
    ...created, assemblyTaskId: id, compositionId: id, compositionItemId: id.optional(), inventoryLotId: id,
    quantity: count, consumedQuantity: count, status: z.enum(['active', 'completed', 'released']),
  }).refine((row) => row.consumedQuantity <= row.quantity, { path: ['consumedQuantity'], message: 'Списание превышает резерв' }),
  aliases: z.looseObject({ ...created, importedCountry: label, importedName: label, inventoryLotId: id }),
  sheetConnections: z.looseObject({
    ...base, url: label, selectedSheets: z.array(label), lastSuccessAt: timestamp.optional(), lastAttemptAt: timestamp.optional(), lastSnapshotId: id.optional(), lastError: text.optional(),
    availableSheets: z.array(z.looseObject({ name: label, gid: label })).optional(),
  }),
  importedCompositions: z.looseObject({
    ...base, sheetConnectionId: id, sheetName: label, sheetGid: label.optional(), column: count, name: label,
    kind: z.enum(['x16', 'x30']), items: z.array(compositionItem).min(1), enabled: z.boolean(), metadata: z.record(text, text), importedAt: timestamp,
  }),
  manualCompositions: z.looseObject({
    ...created, name: label, kind: z.enum(['x6', 'mega6', 'subscription', 'limit']), items: z.array(compositionItem).min(1), enabled: z.boolean(),
  }),
  assemblyPlans: z.looseObject({ ...created, date, status: z.enum(['draft', 'confirmed']) }),
  assemblyTasks: z.looseObject({
    ...created, planId: id, compositionId: id, compositionKind: label, compositionSnapshot: z.array(compositionItem).min(1),
    name: label, plannedQuantity: positiveCount, completedQuantity: count, comment: text.optional(), productionDate: date,
    status: z.enum(['draft', 'pending', 'confirmed', 'partial', 'completed', 'transferred', 'cancelled']),
  }).refine((row) => row.completedQuantity <= row.plannedQuantity, { path: ['completedQuantity'], message: 'Отчёты превышают план' }),
  assemblyReports: z.looseObject({
    ...created, taskId: id, employeeId: id, quantity: count, createdAt: timestamp, productionDate: date, comment: text.optional(),
    correctionComment: text.optional(), correctedAt: timestamp.optional(), previousQuantity: count.optional(),
    deductions: z.array(z.looseObject({ inventoryLotId: id, reservationId: id, quantity: positiveCount, manufacturedAt: timestamp })),
  }),
  employees: z.looseObject({ ...created, lastName: label, firstName: label, active: z.boolean() }),
  productionDays: z.looseObject({ ...base, date, status: z.enum(['open', 'closed']), closedAt: timestamp.optional(), nextWorkingDate: date.optional() }),
  dailyReports: z.looseObject({
    ...created, date, produced: z.array(productionEntry), warnings: z.array(warning),
    assembled: z.array(z.looseObject({ taskId: id, name: label, plan: count, fact: count, remaining: count, employees: z.array(text), comments: z.array(text) })),
  }),
  warnings: warning,
  adjustments: z.looseObject({
    ...created, entityType: z.enum(['inventory', 'report', 'production']), entityId: id,
    previousValue: z.number(), newValue: z.number(), reason: label, comment: text.optional(),
  }),
  auditEvents: z.looseObject({ ...created, action: label, entityType: label, entityId: id, description: label }),
  settings: z.looseObject({
    id: z.literal('settings'), schemaVersion: positiveCount, theme: z.enum(['light', 'dark']), adminPassword: text, updatedAt: timestamp,
    formats: z.array(z.looseObject({ id: formatId, name: label, coefficient, unit: z.literal('шт.') })).length(4)
      .refine((formats) => new Set(formats.map((item) => item.id)).size === 4, 'Форматы должны содержать четыре разных идентификатора'),
    purposes: z.array(label).min(1), nonWorkingDays: z.array(date), workingOverrides: z.array(date),
    calendarSource: z.looseObject({ nonWorkingDays: z.array(date), workingDays: z.array(date) }).optional(),
  }),
}

export const backupEnvelope = z.object({
  schemaVersion: positiveCount,
  exportedAt: timestamp,
  data: z.record(z.string(), z.array(z.unknown())),
})
