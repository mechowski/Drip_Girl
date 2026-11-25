import { logoutServer, serverMode, serverSession, storageChanged } from '@/persistence/remote'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

import { adminPasswordRequired as passwordRequired, adminSessionKey, hasAdminSession } from '@/domain/adminSession'

interface AdminContextValue {
  passwordRequired: boolean
  unlocked: boolean
  unlock: () => void
  lock: () => void
  requestUnlock: () => void
  loginOpen: boolean
  setLoginOpen: (open: boolean) => void
}
const AdminContext = createContext<AdminContextValue | null>(null)

export function AdminProvider({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(() => !serverMode() && hasAdminSession())
  const [loginOpen, setLoginOpen] = useState(false)
  const unlock = () => { sessionStorage.setItem(adminSessionKey, 'yes'); setUnlocked(true); setLoginOpen(false) }
  useEffect(() => {
    if (serverMode()) void serverSession().then(({ role }) => setUnlocked(role === 'admin')).catch(() => setUnlocked(false))
  }, [])
  const lock = () => {
    if (serverMode()) {
      void logoutServer().then(() => window.dispatchEvent(new Event(storageChanged)))
    } else {
      sessionStorage.removeItem(adminSessionKey)
      setUnlocked(false)
    }
  }
  return <AdminContext.Provider value={{ passwordRequired: !serverMode() && passwordRequired, unlocked, lock, requestUnlock: () => serverMode() || passwordRequired ? setLoginOpen(true) : unlock(), unlock, loginOpen, setLoginOpen }}>{children}</AdminContext.Provider>
}

export function useAdmin() {
  const value = useContext(AdminContext)
  if (!value) throw new Error('AdminProvider отсутствует')
  return value
}
