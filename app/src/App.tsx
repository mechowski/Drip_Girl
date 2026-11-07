import { useEffect, useState } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router'
import { Archive, Bell, Boxes, CalendarDays, ClipboardList, Coffee, Factory, Layers3, LayoutDashboard, LockKeyhole, Menu, Moon, ShieldCheck, Sun, Users } from 'lucide-react'
import { Toaster } from 'sonner'
import { MotionConfig } from 'framer-motion'
import { useAppData } from '@/hooks/useAppData'
import { updateSettings, saveImportedCompositions } from '@/persistence/repository'
import { fetchSheetCsv, parseCompositionSheet } from '@/integrations/googleSheets'
import { AdminProvider, useAdmin } from '@/ui/AdminContext'
import { Button, Field, Input, Loading, Modal } from '@/ui/components'
import DashboardPage from '@/pages/DashboardPage'
import LotsPage from '@/pages/LotsPage'
import CalendarPage from '@/pages/CalendarPage'
import ProductionPage from '@/pages/ProductionPage'
import InventoryPage from '@/pages/InventoryPage'
import CompositionsPage from '@/pages/CompositionsPage'
import AssemblyPage from '@/pages/AssemblyPage'
import ReportsPage from '@/pages/ReportsPage'
import EmployeesPage from '@/pages/EmployeesPage'
import AdminPage from '@/pages/AdminPage'
import './App.css'

const productionNavigation = [
  { to: '/today', label: 'Сегодня', icon: LayoutDashboard },
  { to: '/', label: 'Лоты', icon: Coffee },
  { to: '/production', label: 'Производство', icon: Factory },
  { to: '/inventory', label: 'Сток', icon: Boxes },
  { to: '/assembly', label: 'Сборка', icon: ClipboardList },
]
const managementNavigation = [
  { to: '/calendar', label: 'Календарь', icon: CalendarDays },
  { to: '/compositions', label: 'Составы', icon: Layers3 },
  { to: '/reports', label: 'Отчёты', icon: Archive },
  { to: '/employees', label: 'Сотрудники', icon: Users },
  { to: '/admin', label: 'Админпанель', icon: ShieldCheck },
]
const navigation = [...productionNavigation, ...managementNavigation]
const mobileNavigation = [productionNavigation[1], productionNavigation[2], productionNavigation[3], productionNavigation[4]]

function LoginModal() {
  const { loginOpen, setLoginOpen, unlock } = useAdmin(); const data = useAppData()
  const [password, setPassword] = useState(''); const [error, setError] = useState('')
  if (!loginOpen) return null
  return <Modal title="Доступ администратора" onClose={() => { setLoginOpen(false); setError('') }}><form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (password === data.settings.adminPassword) { unlock(); setPassword(''); setError('') } else setError('Неверный пароль') }}><p className="text-sm text-muted">Сессия сохраняется только в текущей вкладке. Это локальное ограничение, не серверная защита.</p><Field label="Пароль" error={error}><Input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Введите пароль" /></Field><Button>Войти</Button></form></Modal>
}

function Shell() {
  const data = useAppData(); const location = useLocation(); const navigate = useNavigate(); const { unlocked, lock, requestUnlock } = useAdmin()
  const [mobileMenu, setMobileMenu] = useState(false)
  const unread = data.warnings.filter((item) => !item.read).length
  const current = navigation.find((item) => item.to === location.pathname) ?? navigation[1]
  useEffect(() => { document.documentElement.classList.toggle('dark', data.settings.theme === 'dark'); document.documentElement.style.colorScheme = data.settings.theme }, [data.settings.theme])
  useEffect(() => {
    const timer = window.setInterval(async () => {
      for (const connection of data.sheetConnections) {
        if (!connection.lastSuccessAt || Date.now() - new Date(connection.lastSuccessAt).getTime() < 24 * 60 * 60 * 1000 || connection.url === 'Локальный CSV') continue
        try {
          const imported = []
          for (const selection of connection.selectedSheets) {
            const [name, gid] = selection.split('::'); if (!gid) continue
            imported.push(...parseCompositionSheet(await fetchSheetCsv(connection.url, gid), name, connection.id))
          }
          if (imported.length) await saveImportedCompositions(connection.id, imported, connection.selectedSheets)
        } catch { /* последний успешный снимок остаётся без изменений */ }
      }
    }, 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [data.sheetConnections])
  const toggleTheme = () => {
    const theme = data.settings.theme === 'dark' ? 'light' : 'dark'
    const style = document.createElement('style')
    style.append(document.createTextNode('*,*::before,*::after{transition:none !important}'))
    document.head.append(style)
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    void document.body.offsetHeight
    requestAnimationFrame(() => requestAnimationFrame(() => style.remove()))
    void updateSettings({ theme })
  }
  const navItems = (items: typeof navigation) => items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'}><Icon size={18} /><span>{label}</span>{label === 'Админпанель' && unread > 0 && <b>{unread}</b>}</NavLink>)
  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('/today')}><span className="brand-mark"><Coffee size={23} /></span><span><strong>Drip Girl</strong><small>производственный контур</small></span></button>
      <div className="nav-section">Производство</div><nav className="side-nav" aria-label="Производственная навигация">{navItems(productionNavigation)}</nav>
      <div className="nav-section">Управление</div><nav className="side-nav" aria-label="Навигация управления">{navItems(managementNavigation)}</nav>
      <div className="sidebar-note"><span className="live-dot" />Локальное хранение<small>IndexedDB · данные в этом браузере</small></div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="mobile-brand"><Coffee size={20} /><strong>Drip Girl</strong></div><div className="topbar-context"><current.icon size={17} /><span>{current.label}</span></div><div className="topbar-actions"><button className="icon-button topbar-icon" onClick={toggleTheme} aria-label={data.settings.theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}>{data.settings.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button><button className="icon-button topbar-icon" onClick={() => navigate('/admin')} aria-label={`Предупреждения: ${unread}`}><Bell size={18} />{unread > 0 && <b>{unread}</b>}</button><Button variant="secondary" size="sm" onClick={() => unlocked ? lock() : requestUnlock()}><LockKeyhole size={16} />{unlocked ? 'Выйти' : 'Администратор'}</Button><span className="user-avatar" aria-label="Данил">ДК</span></div></header>
      <main className="content"><div key={location.pathname}>{data.loading ? <Loading /> : <Routes><Route path="/today" element={<DashboardPage />} /><Route path="/" element={<LotsPage />} /><Route path="/calendar" element={<CalendarPage />} /><Route path="/production" element={<ProductionPage />} /><Route path="/inventory" element={<InventoryPage />} /><Route path="/compositions" element={<CompositionsPage />} /><Route path="/assembly" element={<AssemblyPage />} /><Route path="/reports" element={<ReportsPage />} /><Route path="/employees" element={<EmployeesPage />} /><Route path="/admin" element={<AdminPage />} /></Routes>}</div></main>
    </div>
    <nav className="bottom-nav" aria-label="Мобильная навигация">{mobileNavigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'}><Icon size={20} /><span>{label}</span></NavLink>)}<button onClick={() => setMobileMenu(true)}><Menu size={20} /><span>Ещё</span></button></nav>
    {mobileMenu && <Modal title="Все разделы" onClose={() => setMobileMenu(false)}><div className="mobile-menu-grid">{navigation.map(({ to, label, icon: Icon }) => <button key={to} onClick={() => { navigate(to); setMobileMenu(false) }}><Icon size={21} /><span>{label}</span></button>)}</div></Modal>}
    <LoginModal /><Toaster position="top-right" richColors closeButton />
  </div>
}

export default function App() { return <MotionConfig reducedMotion="user"><AdminProvider><Shell /></AdminProvider></MotionConfig> }
