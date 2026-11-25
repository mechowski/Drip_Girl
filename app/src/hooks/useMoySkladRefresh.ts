import { useEffect } from 'react'
import { refreshMoySklad } from '@/persistence/moySklad'

export function useMoySkladRefresh() {
  useEffect(() => {
    if (!document.querySelector('meta[name="drip-girl-moysklad"][content="enabled"]')) return
    const refresh = () => { void refreshMoySklad().catch(() => { /* Keep the last successfully applied snapshot. */ }) }
    refresh()
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])
}
