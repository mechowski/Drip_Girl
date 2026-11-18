import { useRef, useState, type FormEvent } from 'react'
import { Download, Upload, Database, Trash2 } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { useAppData } from '@/hooks/useAppData'
import { db, exportBackup, importBackup, tableNames, validateBackup } from '@/persistence/db'
import { clearDemoData, seedDemoData, updateSettings } from '@/persistence/repository'
import type { BackupData, Warning } from '@/domain/types'
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

const sections = [
  { id: 'settings', label: 'Настройки производства' },
  { id: 'backup', label: 'Резервные копии' },
  { id: 'journal', label: 'Журнал' },
] as const

const newest = <T extends { createdAt: string }>(rows: T[]) =>
  [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

function warningLink(warning: Warning, data: ReturnType<typeof useAppData>) {
  if (warning.compositionId) return { to: `/compositions?composition=${encodeURIComponent(warning.compositionId)}`, label: 'Состав' }
  if (warning.type === 'import') return { to: '/compositions?tab=google', label: 'Составы' }
  const taskId = warning.taskId ?? data.assemblyReports.find((report) => report.id === warning.reportId)?.taskId
  if (taskId && data.productionTasks.some((task) => task.id === taskId)) {
    return { to: `/production?task=${encodeURIComponent(taskId)}`, label: 'Задача изготовления' }
  }
  if (taskId && data.assemblyTasks.some((task) => task.id === taskId)) {
    return { to: `/assembly#task-${encodeURIComponent(taskId)}`, label: 'Задание сборки' }
  }
  if (warning.lotId && data.lots.some((lot) => lot.id === warning.lotId)) {
    return { to: `/?lot=${encodeURIComponent(warning.lotId)}`, label: 'Лот' }
  }
  return null
}

export default function AdminPage() {
  const data = useAppData()
  const { unlocked, requestUnlock } = useAdmin()
  const [params, setParams] = useSearchParams()
  const section = params.get('section') ?? 'settings'
  const [formats, setFormats] = useState(() => data.settings.formats.map((format) => ({ ...format, coefficient: String(format.coefficient) })))
  const [password, setPassword] = useState(data.settings.adminPassword)
  const [purpose, setPurpose] = useState('')
  const [backupError, setBackupError] = useState('')
  const backupSelection = useRef(0)
  const [importing, setImporting] = useState(false)
  const [backup, setBackup] = useState<BackupData | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!unlocked) return <>
    <PageHeader title="Админпанель" description="Настройки, резервные копии и история" />
    <Empty title="Раздел защищён паролем" text="Для входа нужен локальный пароль администратора." action={<Button onClick={requestUnlock}>Войти как администратор</Button>} />
  </>

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      await updateSettings({
        formats: formats.map((item) => ({ ...item, name: item.name.trim(), coefficient: Number(item.coefficient.replace(',', '.')) })),
        adminPassword: password,
      })
      toast.success('Настройки сохранены')
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка сохранения') }
  }
  const addPurpose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const label = purpose.trim()
    if (!label) return
    if (data.settings.purposes.some((item) => item.toLocaleLowerCase('ru-RU') === label.toLocaleLowerCase('ru-RU'))) {
      toast.error('Такое назначение уже есть')
      return
    }
    try {
      await updateSettings({ purposes: [...data.settings.purposes, label] })
      setPurpose('')
      toast.success('Назначение добавлено')
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка сохранения') }
  }
  const download = async () => {
    try {
      const value = await exportBackup()
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `drip-girl-backup-${value.exportedAt.slice(0, 10)}.json`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success('Резервная копия экспортирована')
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка экспорта') }
  }
  const readBackup = async (file: File) => {
    const selection = ++backupSelection.current
    setBackup(null)
    setBackupError('')
    try {
      const parsed = validateBackup(JSON.parse(await file.text()))
      if (selection === backupSelection.current) setBackup(parsed)
    } catch (error) {
      if (selection === backupSelection.current) {
        setBackupError(error instanceof SyntaxError ? 'Некорректная копия: повреждённый JSON' : `Некорректная копия: ${error instanceof Error ? error.message : 'ошибка чтения'}`)
      }
    }
  }
  const restore = async () => {
    setImporting(true)
    try {
      await importBackup(backup)
      const restored = await db.settings.get('settings')
      if (restored) {
        setFormats(restored.formats.map((format) => ({ ...format, coefficient: String(format.coefficient) })))
        setPassword(restored.adminPassword)
      }
      toast.success('Резервная копия восстановлена')
      setBackup(null)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка импорта') }
    finally { setImporting(false) }
  }
  const runDemoAction = async (action: 'seed' | 'clear') => {
    setBusy(true)
    try {
      if (action === 'seed') {
        await seedDemoData()
        toast.success('Демонстрационные лоты, сток и состав добавлены')
      } else {
        await clearDemoData()
        setClearOpen(false)
        toast.success('Демонстрационные данные удалены')
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка операции') }
    finally { setBusy(false) }
  }
  const changeWarning = async (warning: Warning) => {
    try { await db.warnings.update(warning.id, { read: !warning.read }) }
    catch { toast.error('Не удалось сохранить статус предупреждения') }
  }
  return <>
    <PageHeader title="Админпанель" description="Настройки производства, резервные копии и журнал событий" />
    <div className="filter-pills mb-5" aria-label="Раздел админпанели">
      {sections.map(({ id, label }) => <Button key={id} variant="secondary" aria-pressed={section === id} onClick={() => setParams(id === 'settings' ? {} : { section: id })}>{label}</Button>)}
    </div>
    {section === 'settings' && <div className="grid gap-5">
      <Card>
        <h2 className="card-title mb-4">Форматы и коэффициенты</h2>
        <form className="grid gap-4" onSubmit={saveSettings}>
          {formats.map((format) => <div className="setting-row" key={format.id}>
            <Field label="Название формата"><Input required value={format.name} onChange={(event) => {
              const name = event.target.value
              setFormats((rows) => rows.map((item) => item.id === format.id ? { ...item, name } : item))
            }} /></Field>
            <Field label="Коэффициент, кг/шт."><Input required inputMode="decimal" value={format.coefficient} onChange={(event) => {
              const coefficient = event.target.value
              setFormats((rows) => rows.map((item) => item.id === format.id ? { ...item, coefficient } : item))
            }} /></Field>
          </div>)}
          <Field label="Пароль локального администратора"><Input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
          <div><Button>Сохранить настройки</Button></div>
        </form>
      </Card>
      <Card>
        <h2 className="card-title">Назначения</h2>
        <div className="my-3 flex flex-wrap gap-2">{data.settings.purposes.map((item) => <Badge key={item}>{item}</Badge>)}</div>
        <form className="flex gap-2" onSubmit={addPurpose}>
          <Input required aria-label="Новое назначение" value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Новое назначение" />
          <Button variant="secondary">Добавить</Button>
        </form>
      </Card>
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="card-title">Google Sheets</h2><p className="mt-1 text-sm text-muted">Подключение таблицы и выбор листов для импорта.</p></div>
        <Link className="button button-secondary button-md" to="/compositions?tab=google">Настроить импорт</Link>
      </Card>
      <Card>
        <h2 className="card-title">Демонстрационные данные</h2>
        <p className="my-2 text-sm text-muted">Четыре лота для ×16, два сотрудника, изготовленный сток и активный состав.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => runDemoAction('seed')}><Database size={17} />Заполнить тестовыми данными</Button>
          <Button variant="danger" disabled={busy} onClick={() => setClearOpen(true)}><Trash2 size={17} />Очистить демонстрационные данные</Button>
        </div>
      </Card>
    </div>}
    {section === 'backup' && <Card>
      <h2 className="card-title">Резервная копия</h2>
      <p className="my-2 text-sm text-muted">Формат JSON. Версия схемы {data.settings.schemaVersion}.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={download}><Download size={17} />Экспорт JSON</Button>
        <label className="button button-secondary button-md cursor-pointer focus-within:outline focus-within:outline-2">
          <Upload size={17} />Выбрать файл
          <input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) void readBackup(file)
          }} />
        </label>
      </div>
      {backupError && <p className="mt-3 text-danger" role="alert">{backupError}</p>}
    </Card>}
    {section === 'journal' && <div className="grid gap-5">
      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="card-title">Предупреждения</h2>
          <Badge tone="warning">{data.warnings.filter((item) => !item.read).length} новых</Badge>
        </div>
        <div className="warning-list">
          {!data.warnings.length && <p className="text-muted">Предупреждений нет</p>}
          {newest(data.warnings).map((warning) => {
            const link = warningLink(warning, data)
            return <div key={warning.id} className={`warning-item ${warning.read ? 'read' : ''}`}>
              <span>
                <strong>{warning.message}</strong>
                <small><time dateTime={warning.createdAt}>{new Date(warning.createdAt).toLocaleString('ru-RU')}</time></small>
                {link && <Link className="mt-1 inline-block text-xs underline" to={link.to}>{link.label}</Link>}
              </span>
              <Button variant="ghost" size="sm" aria-label={warning.read ? 'Отметить как непрочитанное' : 'Отметить как прочитанное'} onClick={() => changeWarning(warning)}>
                <Badge>{warning.read ? 'Прочитано' : 'Новое'}</Badge>
              </Button>
            </div>
          })}
        </div>
      </Card>
      <Card>
        <h2 className="card-title">История действий</h2>
        <div className="warning-list mt-3 gap-3">
          {!data.auditEvents.length && <p className="text-muted">Действий пока нет</p>}
          {newest(data.auditEvents).map((event) => <div className="text-sm" key={event.id}>
            <p>{event.description}</p><time className="text-xs text-muted" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('ru-RU')}</time>
          </div>)}
        </div>
      </Card>
    </div>}
    {backup && <Modal title="Предварительный просмотр импорта" onClose={() => { if (!importing) setBackup(null) }} wide>
      <div className="grid gap-4">
        <div className="notice">Импорт полностью заменит текущие локальные данные. Перед заменой можно скачать текущую копию.</div>
        <p>Схема {backup.schemaVersion} · {new Date(backup.exportedAt).toLocaleString('ru-RU')}</p>
        <table className="backup-table" aria-label="Сравнение резервной копии">
          <thead><tr><th scope="col">Таблица</th><th scope="col">Сейчас</th><th scope="col">Из файла</th></tr></thead>
          <tbody>{tableNames.map((name) => <tr key={name}>
            <th scope="row">{tableLabels[name]}</th><td>{formatNumber(name === 'settings' ? 1 : data[name].length)}</td><td>{formatNumber(backup.data[name]?.length ?? 0)}</td>
          </tr>)}</tbody>
        </table>
        <div className="modal-actions">
          <Button variant="secondary" disabled={importing} onClick={download}>Скачать текущую копию</Button>
          <Button variant="ghost" disabled={importing} onClick={() => setBackup(null)}>Отмена</Button>
          <Button variant="danger" disabled={importing} onClick={restore}>Заменить данные</Button>
        </div>
      </div>
    </Modal>}
    {clearOpen && <Modal title="Очистить демонстрационные данные?" onClose={() => { if (!busy) setClearOpen(false) }}>
      <p>Будут удалены записи, созданные демонстрационной кнопкой.</p>
      <div className="modal-actions">
        <Button variant="ghost" disabled={busy} onClick={() => setClearOpen(false)}>Отмена</Button>
        <Button variant="danger" disabled={busy} onClick={() => runDemoAction('clear')}>Очистить демо</Button>
      </div>
    </Modal>}
  </>
}
