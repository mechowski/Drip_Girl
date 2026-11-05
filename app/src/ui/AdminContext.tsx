import { createContext, useContext, useState, type ReactNode } from 'react'

interface AdminContextValue {
  unlocked: boolean
  unlock: () => void
  lock: () => void
  requestUnlock: () => void
  loginOpen: boolean
  setLoginOpen: (open: boolean) => void
}
const AdminContext = createContext<AdminContextValue | null>(null)

export function AdminProvider({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem('drip-girl-admin') === 'yes')
  const [loginOpen, setLoginOpen] = useState(false)
  const unlock = () => { sessionStorage.setItem('drip-girl-admin', 'yes'); setUnlocked(true); setLoginOpen(false) }
  const lock = () => { sessionStorage.removeItem('drip-girl-admin'); setUnlocked(false) }
  return <AdminContext.Provider value={{ unlocked, unlock, lock, requestUnlock: () => setLoginOpen(true), loginOpen, setLoginOpen }}>{children}</AdminContext.Provider>
}

export function useAdmin() {
  const value = useContext(AdminContext)
  if (!value) throw new Error('AdminProvider отсутствует')
  return value
}
