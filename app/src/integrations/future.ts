import type { Warning } from '@/domain/types'

/** Контракты для будущей замены локальных адаптеров серверными интеграциями. */
export interface ExternalNotificationHandler {
  send(warning: Warning): Promise<void>
}

export interface RoastingAppAdapter {
  pullRoastedLots(since: string): Promise<unknown[]>
}

export interface ServerSheetsAdapter {
  synchronize(connectionId: string): Promise<{ updatedAt: string }>
}

export interface RemoteStorageAdapter {
  exportSnapshot(): Promise<Blob>
  importSnapshot(snapshot: Blob): Promise<void>
}
