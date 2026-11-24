import { useState, type FormEvent } from 'react'
import { UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { useAppData } from '@/hooks/useAppData'
import { addEmployee, toggleEmployee } from '@/persistence/repository'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader } from '@/ui/components'

export default function EmployeesPage() {
  const data = useAppData()
  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [disableId, setDisableId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const employee = data.employees.find((item) => item.id === disableId)
  const search = query.trim().toLocaleLowerCase('ru')
  const employees = data.employees.filter((item) => {
    return [`${item.lastName} ${item.firstName}`, `${item.firstName} ${item.lastName}`].some((name) => name.toLocaleLowerCase('ru').includes(search))
  }).sort((a, b) => a.lastName.localeCompare(b.lastName, 'ru') || a.firstName.localeCompare(b.firstName, 'ru'))

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setBusy(true)
    try {
      await addEmployee(String(fields.get('firstName')), String(fields.get('lastName')))
      toast.success('Сотрудник добавлен')
      setAddOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения')
    } finally { setBusy(false) }
  }
  const toggle = async (id: string) => {
    setBusy(true)
    try {
      await toggleEmployee(id)
      setDisableId(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения')
    } finally { setBusy(false) }
  }

  return <>
    <PageHeader title="Сотрудники" description="Справочник участка" action={<Button onClick={() => setAddOpen(true)}><UserPlus size={17} aria-hidden="true" />Добавить сотрудника</Button>} />
    <div className="mb-4 max-w-sm"><Input type="search" aria-label="Поиск сотрудника" placeholder="Фамилия или имя" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    {!employees.length ? <Empty title={search ? 'Сотрудники не найдены' : 'Справочник пуст'} text={search ? 'Проверьте написание имени или фамилии.' : 'Добавьте сотрудника для назначения задач и приёма отчётов.'} /> :
      <Card className="stock-journal"><table className="stock-table" aria-label="Справочник сотрудников">
        <thead><tr><th scope="col">Сотрудник</th><th scope="col">Состояние</th><th scope="col" className="stock-number">Отчёты</th><th scope="col"><span className="sr-only">Действие</span></th></tr></thead>
        <tbody>{employees.map((item) => <tr className="inventory-row" key={item.id}>
          <th scope="row">{item.lastName} {item.firstName}</th>
          <td className="stock-status"><Badge tone={item.active ? 'success' : 'neutral'}>{item.active ? 'Активен' : 'Отключён'}</Badge></td>
          <td className="stock-number"><span>Отчёты</span>{data.assemblyReports.filter((report) => report.employeeId === item.id).length}</td>
          <td className="stock-action"><Button variant="secondary" size="sm" disabled={busy} onClick={() => item.active ? setDisableId(item.id) : void toggle(item.id)}>{item.active ? 'Отключить' : 'Включить'}</Button></td>
        </tr>)}</tbody>
      </table></Card>}
    {addOpen && <Modal title="Добавить сотрудника" onClose={() => { if (!busy) setAddOpen(false) }}>
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Фамилия"><Input required autoFocus name="lastName" /></Field>
        <Field label="Имя"><Input required name="firstName" /></Field>
        <Button disabled={busy}>Добавить сотрудника</Button>
      </form>
    </Modal>}
    {employee && <Modal title={`Отключить сотрудника ${employee.lastName} ${employee.firstName}?`} onClose={() => { if (!busy) setDisableId(null) }}>
      <p>Прошлые отчёты сотрудника сохранятся. Сотрудник исчезнет из списка для новых отчётов и назначений.</p>
      <div className="modal-actions"><Button variant="ghost" disabled={busy} onClick={() => setDisableId(null)}>Отмена</Button><Button variant="danger" disabled={busy} onClick={() => toggle(employee.id)}>Отключить</Button></div>
    </Modal>}
  </>
}
