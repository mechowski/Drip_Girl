import { ProductionCorrectionConflict } from './productionCorrection'
import type { AppSettings } from '@/domain/types'
import type { readAppSnapshot } from './snapshot'

export function serverMode() {
  return typeof document !== 'undefined' && document.querySelector('meta[name="drip-girl-storage"]')?.getAttribute('content') === 'server'
}

export class ServerError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export const storageChanged = 'drip-storage-changed'

async function request<T>(path: string, body?: unknown, key?: string): Promise<T> {
  const response = await fetch('/api/repository/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined)
    if (response.status === 409 && Array.isArray(payload?.taskIds) && Array.isArray(payload?.reportIds)) {
      throw new ProductionCorrectionConflict(payload.error, payload.taskIds, payload.reportIds)
    }
    throw new ServerError(payload?.error ?? 'Не удалось связаться с сервером', response.status)
  }
  return response.status === 204 ? undefined as T : response.json()
}

export type ServerRole = 'operator' | 'admin'
export const loginServer = (role: ServerRole, password: string) => request<{ role: ServerRole }>('login', { role, password })
export const serverSession = () => request<{ role: ServerRole }>('session')
export const logoutServer = () => request<void>('logout', {})

export async function readServerSnapshot() {
  const snapshot = await request<Awaited<ReturnType<typeof readAppSnapshot>>>('snapshot')
  return { ...snapshot, settings: { ...snapshot.settings, adminPassword: '' } as AppSettings }
}

export async function serverCommand<T>(name: string, args: unknown[]): Promise<T> {
  const key = crypto.randomUUID()
  const send = () => request<T>('command/' + name, args, key)
  const result = await send().catch(error => {
    if (error instanceof TypeError) return send()
    throw error
  })
  window.dispatchEvent(new Event(storageChanged))
  return result
}

export function routed<Args extends unknown[], Result>(name: string, local: (...args: Args) => Promise<Result>) {
  return (...args: Args) => serverMode() ? serverCommand<Result>(name, args) : local(...args)
}
