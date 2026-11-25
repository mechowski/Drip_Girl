import { useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import type { ProductionEntry } from '@/domain/types'
import { refreshMoySklad, updateMoySkladEntry } from '@/persistence/moySklad'
import { useAdmin } from './AdminContext'
import { Button, Field, Input, Modal } from './components'

export function MoySkladEntry({ entry }: { entry: ProductionEntry }) {
  const { unlocked } = useAdmin()
  const [editLink, setEditLink] = useState(false)
  const [link, setLink] = useState(entry.moySkladLink ?? '')
  const [busy, setBusy] = useState(false)
  const [showRefresh, setShowRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')

  async function save(posted: boolean, href: string) {
    if (busy) return
    setBusy(true)
    try {
      const last = await updateMoySkladEntry(entry.id, posted, href)
      if (last) { setRefreshError(''); setShowRefresh(true) }
      setEditLink(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить отметку')
    } finally { setBusy(false) }
  }

  async function refresh() {
    setRefreshing(true)
    setRefreshError('')
    try {
      await refreshMoySklad(true)
      setShowRefresh(false)
      toast.success('Остатки обновлены')
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : 'Не удалось обновить остатки')
    } finally { setRefreshing(false) }
  }

  return <div className="grid gap-2">
    {unlocked && <label className="check-filter min-h-9">
      <input type="checkbox" checked={Boolean(entry.moySkladPosted)} disabled={busy}
        onChange={(event) => void save(event.target.checked, entry.moySkladLink ?? '')} />
      Проведено в МС
    </label>}
    {unlocked && Boolean(entry.moySkladPosted) !== Boolean(entry.moySkladApplied) && <p className="text-sm text-muted">Отметка применится после обновления стока.</p>}
    {entry.moySkladLink && <a className="text-sm underline" href={entry.moySkladLink} target="_blank" rel="noreferrer">Техоперация в МоемСкладе</a>}
    {unlocked && (editLink ? <div className="grid gap-2">
      <Field label="Ссылка на техоперацию"><Input type="url" value={link} onChange={(event) => setLink(event.target.value)} /></Field>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void save(Boolean(entry.moySkladPosted), link)}>Сохранить ссылку</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditLink(false)}>Отмена</Button>
      </div>
    </div> : <div><Button type="button" variant="ghost" size="sm" onClick={() => { setLink(entry.moySkladLink ?? ''); setEditLink(true) }}>
      {entry.moySkladLink ? 'Изменить ссылку' : 'Добавить ссылку на техоперацию'}
    </Button></div>)}
    {showRefresh && createPortal(<Modal title="Обновите остатки" onClose={() => { if (!refreshing) setShowRefresh(false) }}>
      <div className="grid gap-4">
        <p>Свежий снимок применит отметки проведённых партий.</p>
        {refreshError && <p className="notice" role="alert">{refreshError}</p>}
        <Button disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Обновляем…' : 'Обновить сток'}</Button>
      </div>
    </Modal>, document.body)}
  </div>
}
