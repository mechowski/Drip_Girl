import type { Employee } from '@/domain/types'
import { Field } from './components'

export function AssemblyParticipants({ employees, joint, selected, onChange }: {
  employees: Employee[]
  joint?: boolean
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const active = employees.filter(({ active }) => active)
  if (!joint) return <Field label="Сборщик">
    <select className="field-control" required value={selected[0] ?? ''} onChange={(event) => onChange(event.target.value ? [event.target.value] : [])}>
      <option value="">Выберите фамилию</option>
      {active.map((item) => <option key={item.id} value={item.id}>{item.lastName} {item.firstName}</option>)}
    </select>
  </Field>

  return <fieldset className="grid gap-2">
    <legend className="mb-2 text-sm font-medium">Участники сборки</legend>
    <p className="text-sm text-muted">Выберите минимум двух сотрудников.</p>
    {active.map((item) => <label className="check-filter min-h-9" key={item.id}>
      <input type="checkbox" checked={selected.includes(item.id)}
        onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />
      {item.lastName} {item.firstName}
    </label>)}
  </fieldset>
}
