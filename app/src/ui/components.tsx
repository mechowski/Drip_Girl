import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { PackageOpen, X } from 'lucide-react'

export function Button({ children, variant = 'primary', size = 'md', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return <button className={`button button-${variant} button-${size} ${className}`} {...props}>{children}</button>
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="field-control" {...props} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="field-control min-h-20 resize-y" {...props} />
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <label className="grid gap-1.5 text-sm font-medium"><span>{label}</span>{children}{hint && <span className="text-xs font-normal text-muted">{hint}</span>}{error && <span className="text-xs text-danger">{error}</span>}</label>
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`surface ${className}`}>{children}</div>
}

export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-mark" aria-hidden="true"><PackageOpen size={22} strokeWidth={1.5} absoluteStrokeWidth /></div><h3>{title}</h3><p>{text}</p>{action}</div>
}

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.contains(previous)) element?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected && !element?.contains(previous)) previous.focus()
    }
  }, [])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const element = dialog.current
      if (!element || Array.from(document.querySelectorAll('.modal[aria-modal="true"]')).at(-1) !== element) return
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const controls = Array.from(element.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
      )).filter((control) => control.getClientRects().length)
      const active = document.activeElement
      const first = controls[0]
      const last = controls.at(-1)
      if (!controls.includes(active as HTMLElement) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault()
        const next = event.shiftKey ? last : first
        next?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])
  return <AnimatePresence><motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><motion.section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'modal-wide' : ''}`} initial={{ opacity: 0, scale: 0.96, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.18 }}><header className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={20} /></button></header><div className="modal-body">{children}</div></motion.section></motion.div></AnimatePresence>
}

export function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{action}</div>
}

export function Loading() {
  return <div className="grid gap-4" aria-label="Загрузка"><div className="skeleton h-24" /><div className="skeleton h-56" /></div>
}
