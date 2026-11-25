import { serverMode } from '@/persistence/remote'
import { useEffect, useRef } from 'react'
import type { SheetConnection } from '@/domain/types'
import { currentSheetConnection, isSheetRefreshDue, refreshPublicSheets } from '@/integrations/sheetSync'

export function useSheetRefresh(connections: SheetConnection[]) {
  const refreshing = useRef(new Set<string>())
  useEffect(() => {
    if (serverMode()) return
    const connection = currentSheetConnection(connections)
    const check = () => {
      if (!connection || !isSheetRefreshDue(connection) || refreshing.current.has(connection.id)) return
      const requests = refreshing.current
      requests.add(connection.id)
      void refreshPublicSheets(connection, connection)
        .catch(() => { /* The failure and last successful snapshot are already stored. */ })
        .finally(() => { requests.delete(connection.id) })
    }
    check()
    const timer = window.setInterval(check, 60_000)
    return () => window.clearInterval(timer)
  }, [connections])
}
