import { useState, type FormEvent } from 'react'
import { UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { useAppData } from '@/hooks/useAppData'
import { addEmployee, toggleEmployee } from '@/persistence/repository'
import { useAdmin } from '@/ui/AdminContext'
import { Badge, Button, Card, Empty, Field, Input, PageHeader } from '@/ui/components'

export default function EmployeesPage() {
  const data = useAppData(); const { unlocked, requestUnlock } = useAdmin()
  const [firstName, setFirstName] = useState(''); const [lastName, setLastName] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await addEmployee(firstName, lastName); toast.success('Сотрудник добавлен'); setFirstName(''); setLastName('') } catch (error) { toast.error(error instanceof Error ? error.message : 'Ошибка') } }
  if (!unlocked) return <><PageHeader title="Сотрудники" description="Справочник доступен администратору" /><Empty title="Нужен доступ администратора" text="Исторические отчёты сохраняются даже после отключения сотрудника." action={<Button onClick={requestUnlock}>Войти как администратор</Button>} /></>
  return <><PageHeader title="Сотрудники" description="Сборщики выбирают себя в отчёте без отдельного входа" /><Card className="mb-5"><form className="form-grid items-end" onSubmit={submit}><Field label="Фамилия"><Input required value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Иванова" /></Field><Field label="Имя"><Input required value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Анна" /></Field><Button><UserPlus size={17} />Добавить сотрудника</Button></form></Card>{!data.employees.length ? <Empty title="Справочник пуст" text="Добавьте сотрудников, чтобы назначать ответственных и принимать отчёты." /> : <div className="card-grid">{data.employees.sort((a, b) => a.lastName.localeCompare(b.lastName, 'ru')).map((employee) => <Card key={employee.id}><div className="flex items-center justify-between gap-3"><div><h2 className="card-title">{employee.lastName} {employee.firstName}</h2><p className="mt-1 text-sm text-muted">Отчётов: {data.assemblyReports.filter((report) => report.employeeId === employee.id).length}</p></div><Badge tone={employee.active ? 'success' : 'neutral'}>{employee.active ? 'Активен' : 'Отключён'}</Badge></div><Button className="mt-4" variant="secondary" size="sm" onClick={() => toggleEmployee(employee.id)}>{employee.active ? 'Отключить' : 'Вернуть'}</Button></Card>)}</div>}</>
}
