import { createContext, useContext, useState, type ReactNode } from 'react'

// Restore the password prompt by setting this to true after testing.
const passwordRequired: boolean = false
const sessionKey = passwordRequired ? 'drip-girl-admin' : 'drip-girl-admin-test'

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
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(sessionKey) === 'yes')
  const [loginOpen, setLoginOpen] = useState(false)
  const unlock = () => { sessionStorage.setItem(sessionKey, 'yes'); setUnlocked(true); setLoginOpen(false) }
  const lock = () => { sessionStorage.removeItem(sessionKey); setUnlocked(false) }
  return <AdminContext.Provider value={{ passwordRequired, unlocked, lock, requestUnlock: () => passwordRequired ? setLoginOpen(true) : unlock(), unlock, loginOpen, setLoginOpen }}>{children}</AdminContext.Provider>
}

export function useAdmin() {
  const value = useContext(AdminContext)
  if (!value) throw new Error('AdminProvider отсутствует')
  return value
}
