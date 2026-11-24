import { createContext } from 'react'
import type { ProductionDialogMode } from './ProductionTaskDialog'

export type QuickView =
  | { kind: 'production'; id: string; mode: ProductionDialogMode }
  | { kind: 'assembly' | 'plan' | 'lot' | 'new-lot' | 'composition'; id: string }

export const QuickViewContext = createContext<((view: QuickView, trigger: HTMLElement) => void) | null>(null)
