import type { ReactNode } from 'react'
import { Link } from 'react-router'

export function LotCard({ title, subtitle, lotId, children }: {
  title: string
  subtitle?: string
  lotId?: string
  children: ReactNode
}) {
  return <article className="lot-panel">
    <header className="lot-panel-header">
      <div>
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {lotId && <Link to={`/?lot=${encodeURIComponent(lotId)}`}>Открыть лот</Link>}
    </header>
    {children}
  </article>
}
