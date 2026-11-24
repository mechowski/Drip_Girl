import { useEffect, useRef, useState } from 'react'
import { format } from 'date-fns'
import { Bell } from 'lucide-react'
import { Link } from 'react-router'
import type { Warning } from '@/domain/types'

export function WarningsDropdown({ warnings, unread }: { warnings: Warning[]; unread: number }) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      if (wrapper.current?.contains(document.activeElement)) trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const recent = open ? [...warnings].sort((a, b) => Number(a.read) - Number(b.read) || b.createdAt.localeCompare(a.createdAt)).slice(0, 8) : []
  return <div className="warnings-control" ref={wrapper}>
    <button ref={trigger} className="icon-button topbar-icon" type="button" aria-label={`Предупреждения: ${unread}`}
      aria-expanded={open} aria-controls={open ? 'topbar-warnings' : undefined} onClick={() => setOpen(!open)}>
      <Bell size={18} aria-hidden="true" />{unread > 0 && <b aria-hidden="true">{unread}</b>}
    </button>
    {open && <section className="warnings-popover" id="topbar-warnings" aria-label="Оповещения администратора">
      <h2>Оповещения</h2>
      {recent.length > 0 ? <ul>{recent.map((warning) => <li key={warning.id}>
        <div><time dateTime={warning.createdAt}>{format(new Date(warning.createdAt), 'dd.MM.yyyy HH:mm')}</time>
          {!warning.read && <span>Новое</span>}
        </div>
        <p>{warning.message}</p>
      </li>)}</ul> : <p>Оповещений пока нет.</p>}
      <Link className="button button-secondary button-sm" to="/admin?section=journal" onClick={() => setOpen(false)}>Открыть журнал</Link>
    </section>}
  </div>
}
