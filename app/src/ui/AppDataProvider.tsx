import { Component, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { appData, AppDataContext } from '@/hooks/useAppData'
import { readAppSnapshot } from '@/persistence/snapshot'
import { Button, Empty } from './components'

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

export function AppDataProvider({ children }: { children: ReactNode }) {
  return <StorageErrorBoundary><AppDataSubscription>{children}</AppDataSubscription></StorageErrorBoundary>
}
