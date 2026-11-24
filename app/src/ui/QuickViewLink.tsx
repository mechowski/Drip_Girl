import { useContext, type ComponentProps } from 'react'
import { Link } from 'react-router'
import { QuickViewContext, type QuickView } from './QuickViewContext'

function getQuickView(to: string): QuickView | undefined {
  const base = new URL(to, 'https://local.invalid')
  const params = base.searchParams
  if (base.pathname === '/production' && params.get('task')) {
    return { kind: 'production', id: params.get('task')!, mode: params.get('action') === 'produce' ? 'release' : 'details' }
  }
  if (base.pathname === '/assembly') {
    const match = /^#(task|plan)-(.+)$/.exec(base.hash)
    if (match) return { kind: match[1] === 'task' ? 'assembly' : 'plan', id: decodeURIComponent(match[2]) }
  }
  if (base.pathname === '/' && params.has('new')) return { kind: 'new-lot', id: 'new' }
  if (base.pathname === '/' && params.get('lot')) return { kind: 'lot', id: params.get('lot')! }
  if (base.pathname === '/compositions' && params.get('composition')) return { kind: 'composition', id: params.get('composition')! }
}

export function QuickViewLink({ to, onClick, ...props }: Omit<ComponentProps<typeof Link>, 'to'> & { to: string }) {
  const open = useContext(QuickViewContext)
  const view = getQuickView(to)
  return <Link {...props} to={to} onClick={(event) => {
    onClick?.(event)
    if (!open || !view || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target) return
    event.preventDefault()
    open(view, event.currentTarget)
  }} />
}
