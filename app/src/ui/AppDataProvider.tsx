import { Component, useEffect, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { appData, AppDataContext } from '@/hooks/useAppData'
import { readAppSnapshot } from '@/persistence/snapshot'
import { loginServer, readServerSnapshot, ServerError, serverMode, storageChanged, type ServerRole } from '@/persistence/remote'
import { Button, Empty, Field, Input } from './components'

class StorageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <main className="content">
      <Empty title="Не удалось открыть приложение" text="Проверьте доступ к хранилищу в браузере и обновите страницу."
        action={<Button onClick={() => window.location.reload()}>Обновить страницу</Button>} />
    </main>
  }
}

function AppDataSubscription({ children }: { children: ReactNode }) {
  const snapshot = useLiveQuery(readAppSnapshot, [])
  return <AppDataContext.Provider value={appData(snapshot)}>{children}</AppDataContext.Provider>
}

function ServerDataSubscription({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof readServerSnapshot>>>()
  const [needsLogin, setNeedsLogin] = useState(false)
  const [role, setRole] = useState<ServerRole>('operator')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let sequence = 0
    const refresh = () => {
      const current = ++sequence
      void readServerSnapshot().then(value => {
        if (current !== sequence) return
        setSnapshot(value)
        setNeedsLogin(false)
        setError('')
      }).catch(reason => {
        if (current !== sequence) return
        if (reason instanceof ServerError && reason.status === 401) {
          setSnapshot(undefined)
          setNeedsLogin(true)
        } else {
          setError('Нет связи с сервером. Попробуйте снова.')
        }
      })
    }
    window.addEventListener(storageChanged, refresh)
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(() => { if (!needsLogin) refresh() }, 5000)
    if (!needsLogin) refresh()
    return () => {
      sequence++
      window.removeEventListener(storageChanged, refresh)
      window.removeEventListener('focus', refresh)
      window.clearInterval(timer)
    }
  }, [needsLogin])
  if (needsLogin) return <main className="content"><form className="grid max-w-sm gap-4" onSubmit={event => {
    event.preventDefault()
    setBusy(true)
    void loginServer(role, password).then(() => {
      setPassword('')
      setError('')
      setNeedsLogin(false)
    }).catch(reason => setError(reason.message)).finally(() => setBusy(false))
  }}>
    <h1>Вход в Дриповщицу</h1>
    <Field label="Роль"><select value={role} onChange={event => setRole(event.target.value as ServerRole)}><option value="operator">Оператор</option><option value="admin">Администратор</option></select></Field>
    <Field label="Пароль" error={error}><Input type="password" required value={password} onChange={event => setPassword(event.target.value)} /></Field>
    <Button disabled={busy}>Войти</Button>
  </form></main>
  if (!snapshot) return <main className="content"><p role="status">{error || 'Подключение к серверу…'}</p></main>
  return <AppDataContext.Provider value={appData(snapshot)}>{error && <p role="alert">{error}</p>}{children}</AppDataContext.Provider>
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  return <StorageErrorBoundary>{serverMode() ? <ServerDataSubscription>{children}</ServerDataSubscription> : <AppDataSubscription>{children}</AppDataSubscription>}</StorageErrorBoundary>
}
