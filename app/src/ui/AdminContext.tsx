import { createContext, useContext, useState, type ReactNode } from 'react'

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
  const [unlocked, setUnlocked] = useState(hasAdminSession)
  const [loginOpen, setLoginOpen] = useState(false)
  const unlock = () => { sessionStorage.setItem(adminSessionKey, 'yes'); setUnlocked(true); setLoginOpen(false) }
  const lock = () => { sessionStorage.removeItem(adminSessionKey); setUnlocked(false) }
  return <AdminContext.Provider value={{ passwordRequired, unlocked, lock, requestUnlock: () => passwordRequired ? setLoginOpen(true) : unlock(), unlock, loginOpen, setLoginOpen }}>{children}</AdminContext.Provider>
}

export function useAdmin() {
  const value = useContext(AdminContext)
  if (!value) throw new Error('AdminProvider отсутствует')
  return value
}
