import { routed, serverCommand, serverMode } from './remote'
import * as local0 from './repository'
export const addEmployee = routed('addEmployee', local0.addEmployee)
export const toggleEmployee = routed('toggleEmployee', local0.toggleEmployee)
export const createLot = routed('createLot', local0.createLot)
export const updateLot = routed('updateLot', local0.updateLot)
export const deleteLot = routed('deleteLot', local0.deleteLot)
export const updateLotDegassing = routed('updateLotDegassing', local0.updateLotDegassing)
export const updateProductionCalendar = routed('updateProductionCalendar', local0.updateProductionCalendar)
export const approveSchedule = routed('approveSchedule', local0.approveSchedule)
export const markBU = routed('markBU', local0.markBU)
export const produce = routed('produce', local0.produce)
export const writeOffProduction = routed('writeOffProduction', local0.writeOffProduction)
export const adjustInventory = routed('adjustInventory', local0.adjustInventory)
export const reassignInventory = routed('reassignInventory', local0.reassignInventory)
export const createAssemblyPlan = routed('createAssemblyPlan', local0.createAssemblyPlan)
export const confirmAssemblyPlan = routed('confirmAssemblyPlan', local0.confirmAssemblyPlan)
export const correctAssemblyReport = routed('correctAssemblyReport', local0.correctAssemblyReport)
export const reportAssembly = routed('reportAssembly', local0.reportAssembly)
export const warnAdmin = routed('warnAdmin', local0.warnAdmin)
export const cancelAssemblyTask = routed('cancelAssemblyTask', local0.cancelAssemblyTask)
export const closeProductionDay = routed('closeProductionDay', local0.closeProductionDay)
export const clearDemoData = routed('clearDemoData', local0.clearDemoData)
export const seedDemoData = routed('seedDemoData', local0.seedDemoData)
export const updateSettings = routed('updateSettings', local0.updateSettings)
import * as local1 from './compositions'
export const addManualComposition = routed('addManualComposition', local1.addManualComposition)
export const deleteComposition = routed('deleteComposition', local1.deleteComposition)
export const saveAlias = routed('saveAlias', local1.saveAlias)
export const saveImportedCompositions = routed('saveImportedCompositions', local1.saveImportedCompositions)
export const toggleComposition = routed('toggleComposition', local1.toggleComposition)
export const updateImportedComposition = routed('updateImportedComposition', local1.updateImportedComposition)
export const updateManualComposition = routed('updateManualComposition', local1.updateManualComposition)
import * as local2 from './productionCorrection'
export const correctProductionEntry = routed('correctProductionEntry', local2.correctProductionEntry)
import * as local3 from './moySklad'
export const updateMoySkladEntry = routed('updateMoySkladEntry', local3.updateMoySkladEntry)
export { summarizeAssembly, tasksToTransfer } from './repository'
export { productionEntryForBatch, ProductionCorrectionConflict } from './productionCorrection'
export const refreshMoySklad = (force = false) => serverMode() ? serverCommand<Awaited<ReturnType<typeof local3.refreshMoySklad>>>('refreshMoySklad', [force]) : local3.refreshMoySklad(force)

import { refreshPublicSheets as localRefreshPublicSheets } from '@/integrations/sheetSync'
export const refreshPublicSheets = routed('refreshPublicSheets', localRefreshPublicSheets)
