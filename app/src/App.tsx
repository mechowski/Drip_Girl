import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router'
import { Archive, Boxes, CalendarDays, ClipboardList, Coffee, Database, Factory, Layers3, LayoutDashboard, LockKeyhole, Menu, Moon, ShieldCheck, Sun, Users } from 'lucide-react'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import { toast, Toaster } from 'sonner'
import { MotionConfig } from 'framer-motion'
import { useAppData } from '@/hooks/useAppData'
import { updateSettings } from '@/persistence/repository'
import { useMoySkladRefresh } from '@/hooks/useMoySkladRefresh'
import { useSheetRefresh } from '@/hooks/useSheetRefresh'
import { AdminProvider, useAdmin } from '@/ui/AdminContext'
import { AppDataProvider } from '@/ui/AppDataProvider'
import { Button, Field, Input, Loading, Modal } from '@/ui/components'
import { WarningsDropdown } from '@/ui/WarningsDropdown'
import { QuickViews } from '@/ui/QuickViews'
import './App.css'

const DashboardPage = lazy(() => import('@/pages/DashboardPage'))
const LotsPage = lazy(() => import('@/pages/LotsPage'))
const CalendarPage = lazy(() => import('@/pages/CalendarPage'))
const ProductionPage = lazy(() => import('@/pages/ProductionPage'))
const InventoryPage = lazy(() => import('@/pages/InventoryPage'))
const CompositionsPage = lazy(() => import('@/pages/CompositionsPage'))
const AssemblyPage = lazy(() => import('@/pages/AssemblyPage'))
const ReportsPage = lazy(() => import('@/pages/ReportsPage'))
const EmployeesPage = lazy(() => import('@/pages/EmployeesPage'))
const AdminPage = lazy(() => import('@/pages/AdminPage'))

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
  { to: '/employees', label: 'Сотрудники', icon: Users, adminOnly: true },
  { to: '/admin', label: 'Админпанель', icon: ShieldCheck, adminOnly: true },
]
const mobileNavigation = [productionNavigation[0], productionNavigation[2], productionNavigation[3], productionNavigation[4]]

function LoginModal() {
  const { loginOpen, setLoginOpen, unlock } = useAdmin(); const data = useAppData()
  const [password, setPassword] = useState(''); const [error, setError] = useState('')
  if (!loginOpen) return null
  return <Modal title="Доступ администратора" onClose={() => { setLoginOpen(false); setPassword(''); setError('') }}><form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (password === data.settings.adminPassword) { unlock(); setPassword(''); setError('') } else setError('Неверный пароль') }}><Field label="Пароль" error={error}><Input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Введите пароль" /></Field><Button>Войти</Button></form></Modal>
}

function Shell() {
  const data = useAppData(); const location = useLocation(); const navigate = useNavigate(); const { unlocked, lock, requestUnlock } = useAdmin()
  const [mobileMenu, setMobileMenu] = useState(false)
  const unread = unlocked ? data.warnings.filter((item) => !item.read).length : 0
  const visibleManagement = managementNavigation.filter((item) => unlocked || !item.adminOnly)
  const now = new Date()
  useEffect(() => { document.documentElement.classList.toggle('dark', data.settings.theme === 'dark'); document.documentElement.style.colorScheme = data.settings.theme }, [data.settings.theme])
  useSheetRefresh(data.sheetConnections)
  useMoySkladRefresh()
  const toggleTheme = () => {
    const theme = data.settings.theme === 'dark' ? 'light' : 'dark'
    const style = document.createElement('style')
    style.append(document.createTextNode('*,*::before,*::after{transition:none !important}'))
    document.head.append(style)
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    void document.body.offsetHeight
    requestAnimationFrame(() => requestAnimationFrame(() => style.remove()))
    void updateSettings({ theme }).catch(() => {
      document.documentElement.classList.toggle('dark', data.settings.theme === 'dark')
      document.documentElement.style.colorScheme = data.settings.theme
      toast.error('Не удалось сохранить тему')
    })
  }
  const navItems = (items: typeof productionNavigation) => items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'}><Icon size={18} /><span>{label}</span>{label === 'Админпанель' && unread > 0 && <b>{unread}</b>}</NavLink>)
  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('/today')}><span className="brand-mark"><Coffee size={23} /></span><span><strong>Дриповщица</strong></span></button>
      <div className="nav-section">Рабочая смена</div><nav className="side-nav" aria-label="Производственная навигация">{navItems(productionNavigation)}</nav>
      <div className="nav-section">Управление</div><nav className="side-nav" aria-label="Навигация управления">{navItems(visibleManagement)}</nav>
      <div className="sidebar-note"><Database size={16} aria-hidden="true" />Локальное хранение</div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="mobile-brand"><Coffee size={20} /><strong>Дриповщица</strong></div><div className="topbar-context"><CalendarDays size={17} aria-hidden="true" /><time dateTime={format(now, 'yyyy-MM-dd')}>{format(now, 'EEEE, d MMMM', { locale: ru })}</time></div><div className="topbar-actions"><button className="icon-button topbar-icon" disabled={data.loading} onClick={toggleTheme} aria-label={data.settings.theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}>{data.settings.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>{unlocked && <WarningsDropdown key={location.key} warnings={data.warnings} unread={unread} />}
        <Button variant={unlocked ? 'primary' : 'secondary'} size="sm" disabled={data.loading} aria-pressed={unlocked} onClick={unlocked ? lock : requestUnlock}><LockKeyhole size={16} aria-hidden="true" />Режим администратора</Button></div></header>
      <main className="content">
        <Suspense key={`${location.pathname}:${unlocked}`} fallback={<Loading />}>
          {data.loading ? <Loading /> : <QuickViews><Routes>
            <Route path="/today" element={<DashboardPage />} />
            <Route path="/" element={<LotsPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/production" element={<ProductionPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/compositions" element={<CompositionsPage />} />
            <Route path="/assembly" element={<AssemblyPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/employees" element={unlocked ? <EmployeesPage /> : <Navigate to="/today" replace />} />
            <Route path="/admin" element={unlocked ? <AdminPage /> : <Navigate to="/today" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes></QuickViews>}
        </Suspense>
      </main>
    </div>
    <nav className="bottom-nav" aria-label="Мобильная навигация">{mobileNavigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'}><Icon size={20} /><span>{label}</span></NavLink>)}<button onClick={() => setMobileMenu(true)}><Menu size={20} /><span>Ещё</span></button></nav>
    {mobileMenu && <Modal title="Все разделы" onClose={() => setMobileMenu(false)}><div className="mobile-menu-grid">{[productionNavigation[1], ...visibleManagement].map(({ to, label, icon: Icon }) => <button key={to} onClick={() => { navigate(to); setMobileMenu(false) }}><Icon size={21} /><span>{label}</span></button>)}</div></Modal>}
    <LoginModal /><Toaster position="top-right" richColors closeButton />
  </div>
}

export default function App() { return <MotionConfig reducedMotion="user"><AppDataProvider><AdminProvider><Shell /></AdminProvider></AppDataProvider></MotionConfig> }
