import { useRef, useState } from 'react'
import { Download, Upload, Database, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppData } from '@/hooks/useAppData'
import { db, exportBackup, importBackup, tableNames, validateBackup } from '@/persistence/db'
import { clearDemoData, seedDemoData, updateSettings } from '@/persistence/repository'
import type { BackupData } from '@/domain/types'
import { formatNumber } from '@/domain/calculations'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader } from '@/ui/components'

const tableLabels: Record<(typeof tableNames)[number], string> = {
  lots: 'Лоты', allocations: 'Распределение лотов', productionTasks: 'Задачи производства',
  productionEntries: 'Выпуск', inventory: 'Партии на стоке', inventoryTransactions: 'Операции стока',
  reservations: 'Резервы', aliases: 'Сопоставления лотов', sheetConnections: 'Подключения таблиц',
  importedCompositions: 'Импортированные составы', manualCompositions: 'Ручные составы',
  assemblyPlans: 'Планы сборки', assemblyTasks: 'Задания сборки', assemblyReports: 'Отчёты сборщиков',
  employees: 'Сотрудники', productionDays: 'Смены', dailyReports: 'Архив смен',
  warnings: 'Предупреждения', adjustments: 'Корректировки', auditEvents: 'Журнал', settings: 'Настройки',
}

export default function AdminPage() {
  const data = useAppData(); const { unlocked, requestUnlock } = useAdmin()
  const [formats, setFormats] = useState(data.settings.formats); const [password, setPassword] = useState(data.settings.adminPassword); const [purpose, setPurpose] = useState('')
  const [section, setSection] = useState<'settings' | 'backup' | 'journal'>('settings')
  const [backupError, setBackupError] = useState('')
  const backupSelection = useRef(0)
  const [importing, setImporting] = useState(false)
  const [backup, setBackup] = useState<BackupData | null>(null); const [clearOpen, setClearOpen] = useState(false); const [busy, setBusy] = useState(false)
  if (!unlocked) return <><PageHeader title="Админпанель" description="Настройки, резервные копии и история" /><Empty title="Раздел защищён паролем" text="Локальный пароль ограничивает доступ к административным операциям, но не заменяет серверную авторизацию." action={<Button onClick={requestUnlock}>Войти как администратор</Button>} /></>
  const saveSettings = async () => { try { if (formats.some((item) => item.coefficient <= 0)) throw new Error('Коэффициенты должны быть положительными'); await updateSettings({ formats, adminPassword: password }); toast.success('Настройки сохранены. Завершённые операции не пересчитаны.') } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка') } }
  const download = async () => { const value = await exportBackup(); const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `drip-girl-backup-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url); toast.success('Резервная копия экспортирована') }
  const readBackup = async (file: File) => {
    const selection = ++backupSelection.current
    setBackup(null)
    setBackupError('')
    try {
      const parsed = validateBackup(JSON.parse(await file.text()))
      if (selection === backupSelection.current) setBackup(parsed)
    } catch (error) {
      if (selection === backupSelection.current) setBackupError(error instanceof Error ? `Некорректная копия: ${error.message}` : 'Повреждённый JSON')
    }
  }
  const seed = async () => { setBusy(true); try { await seedDemoData(); toast.success('Демонстрационные лоты, сток и состав добавлены') } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка') } finally { setBusy(false) } }
  return <>
    <PageHeader title="Админпанель" description="Конфигурация, события и локальное управление данными" />
    <div className="filter-pills mb-5" aria-label="Раздел админпанели">
      <Button variant="secondary" aria-pressed={section === 'settings'} onClick={() => setSection('settings')}>Настройки производства</Button>
      <Button variant="secondary" aria-pressed={section === 'backup'} onClick={() => setSection('backup')}>Резервные копии</Button>
      <Button variant="secondary" aria-pressed={section === 'journal'} onClick={() => setSection('journal')}>Журнал</Button>
    </div>
    {section === 'settings' && <div className="grid gap-5"><Card><h2 className="card-title">Форматы и коэффициенты</h2><p className="mb-4 mt-1 text-sm text-muted">Новые значения применяются только к будущим операциям.</p><div className="grid gap-3">{formats.map((format, index) => <div className="setting-row" key={format.id}><span>{format.name}</span><Input aria-label={`Коэффициент ${format.name}`} type="number" min="0.001" step="0.0001" value={format.coefficient} onChange={(e) => setFormats(formats.map((item, i) => i === index ? { ...item, coefficient: Number(e.target.value) } : item))} /><span>кг/шт.</span></div>)}</div><div className="mt-4 grid gap-3"><Field label="Пароль локального администратора"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field><Button onClick={saveSettings}>Сохранить настройки</Button></div></Card><Card><h2 className="card-title">Назначения</h2><div className="my-3 flex flex-wrap gap-2">{data.settings.purposes.map((item) => <Badge key={item}>{item}</Badge>)}</div><div className="flex gap-2"><Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Новое назначение" /><Button variant="secondary" onClick={async () => { if (!purpose.trim()) return; await updateSettings({ purposes: [...new Set([...data.settings.purposes, purpose.trim()])] }); setPurpose(''); toast.success('Назначение добавлено') }}>Добавить</Button></div></Card><Card><h2 className="card-title">Демонстрационные данные</h2><p className="my-2 text-sm text-muted">Четыре лота для ×16, два сотрудника, изготовленный сток и активный состав.</p><div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={seed}><Database size={17} />Заполнить тестовыми данными</Button><Button variant="danger" onClick={() => setClearOpen(true)}><Trash2 size={17} />Очистить демо</Button></div></Card></div>}
    {section === 'backup' && <Card><h2 className="card-title">Резервная копия</h2><p className="my-2 text-sm text-muted">Полный JSON: сток, история, отчёты, составы, настройки и архив. Схема данных: версия {data.settings.schemaVersion}.</p><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={download}><Download size={17} />Экспорт JSON</Button><label className="button button-secondary button-md cursor-pointer"><Upload size={17} />Выбрать файл<input type="file" accept="application/json" className="sr-only" onChange={(event) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (file) void readBackup(file)
    }} /></label></div>{backupError && <p className="mt-3 text-danger" role="alert">{backupError}</p>}</Card>}
    {section === 'journal' && <div className="grid gap-5"><Card><div className="mb-3 flex items-center justify-between"><h2 className="card-title">Предупреждения</h2><Badge tone="warning">{data.warnings.filter((item) => !item.read).length} новых</Badge></div><div className="warning-list">{!data.warnings.length && <p className="text-muted">Предупреждений нет</p>}{data.warnings.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((warning) => <button key={warning.id} className={`warning-item ${warning.read ? 'read' : ''}`} onClick={() => db.warnings.update(warning.id, { read: !warning.read })}><span><strong>{warning.message}</strong><small>{new Date(warning.createdAt).toLocaleString('ru-RU')}</small></span><Badge>{warning.read ? 'Прочитано' : 'Новое'}</Badge></button>)}</div></Card><Card><h2 className="card-title">История действий</h2><div className="mt-3 grid gap-3">{data.auditEvents.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((event) => <div className="text-sm" key={event.id}><p>{event.description}</p><time className="text-xs text-muted">{new Date(event.createdAt).toLocaleString('ru-RU')}</time></div>)}</div></Card></div>}
    {backup && <Modal title="Предварительный просмотр импорта" onClose={() => { if (!importing) setBackup(null) }} wide><div className="grid gap-4"><div className="notice">Импорт полностью заменит текущие локальные данные. Сначала рекомендуется экспортировать текущую копию.</div><p>Схема: {backup.schemaVersion} · экспортировано: {new Date(backup.exportedAt).toLocaleString('ru-RU')}</p><table className="backup-table" aria-label="Сравнение резервной копии"><thead><tr><th scope="col">Таблица</th><th scope="col">Сейчас</th><th scope="col">Из файла</th></tr></thead><tbody>
      {tableNames.map((name) => <tr key={name}><th scope="row">{tableLabels[name]}</th><td>{formatNumber(name === 'settings' ? 1 : data[name].length)}</td><td>{formatNumber(backup.data[name]?.length ?? 0)}</td></tr>)}
    </tbody></table><div className="modal-actions"><Button variant="ghost" disabled={importing} onClick={() => setBackup(null)}>Отмена</Button><Button variant="danger" disabled={importing} onClick={async () => { setImporting(true); try { await importBackup(backup); const restored = await db.settings.get('settings'); if (restored) { setFormats(restored.formats); setPassword(restored.adminPassword) } toast.success('Резервная копия восстановлена'); setBackup(null) } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка импорта') } finally { setImporting(false) } }}>Заменить данные</Button></div></div></Modal>}
    {clearOpen && <Modal title="Очистить демонстрационные данные?" onClose={() => setClearOpen(false)}><p>Удаляются только записи, созданные демонстрационной кнопкой. Пользовательские данные останутся.</p><div className="modal-actions"><Button variant="ghost" onClick={() => setClearOpen(false)}>Отмена</Button><Button variant="danger" onClick={async () => { await clearDemoData(); setClearOpen(false); toast.success('Демонстрационные данные удалены') }}>Очистить демо</Button></div></Modal>}
  </>
}
