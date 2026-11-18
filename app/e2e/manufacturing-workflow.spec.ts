import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { AssemblyReport, AssemblyTask, BackupData, Employee, InventoryLot, InventoryTransaction, StockReservation } from '../src/domain/types'

test.use({ reducedMotion: 'reduce' })

const roastDate = '2025-10-06'
const shiftDate = '2025-10-09'
const setName = 'Дегустационный набор'
const lots = [
  { country: 'Эфиопия', name: 'Гуджи', weight: '0.2904' },
  { country: 'Колумбия', name: 'Уила', weight: '0.242' },
  { country: 'Бразилия', name: 'Серрадо', weight: '0.242' },
  { country: 'Кения', name: 'Ньери', weight: '0.1936' },
]
const employees = [
  { last: 'Иванова', first: 'Анна' },
  { last: 'Петров', first: 'Максим' },
]
const lotLabel = ({ country, name }: (typeof lots)[number]) => `${country} / ${name}`
const employeeLabel = ({ last, first }: (typeof employees)[number]) => `${last} ${first}`
const goTo = (page: Page, name: string) => page.getByRole('link', { name, exact: true }).click()

async function unlock(page: Page) {
  await page.getByRole('button', { name: 'Администратор', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Доступ администратора' })
  await dialog.getByLabel('Пароль').fill('1337')
  await dialog.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

async function addEmployee(page: Page, employee: (typeof employees)[number]) {
  await page.getByRole('button', { name: 'Добавить сотрудника' }).click()
  const dialog = page.getByRole('dialog', { name: 'Добавить сотрудника' })
  await dialog.getByLabel('Фамилия').fill(employee.last)
  await dialog.getByLabel('Имя', { exact: true }).fill(employee.first)
  await dialog.getByRole('button', { name: 'Добавить сотрудника' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('rowheader', { name: employeeLabel(employee) })).toBeVisible()
}

async function produce(page: Page, lot: (typeof lots)[number], quantity: number) {
  const task = page.locator('.production-task').filter({ has: page.getByRole('heading', { name: lotLabel(lot), exact: true }) })
  await task.getByRole('button', { name: 'Внести выпуск' }).click()
  const dialog = page.getByRole('dialog', { name: 'Внести выпуск' })
  await dialog.getByLabel('Фактическое количество, шт.').fill(String(quantity))
  await dialog.getByLabel('Ответственный').selectOption({ label: employeeLabel(employees[0]) })
  await dialog.getByRole('button', { name: 'Отправить на сток' }).click()
  await expect(dialog).toHaveCount(0)
  const writeOff = page.getByRole('dialog', { name: 'Списать остаток кофе?' })
  if (await writeOff.isVisible()) await writeOff.getByRole('button', { name: 'Не списывать' }).click()
  const release = page.getByRole('status').filter({ hasText: 'На сток поступило' })
  await expect(release.getByText(`${quantity} шт.`, { exact: true })).toBeVisible()
}

async function expectStock(page: Page, physical: number, reserved: number) {
  const stats = page.locator('.stats-strip').first()
  for (const [label, value] of [['Физический остаток', physical], ['В резерве', reserved], ['Доступно', physical - reserved]] as const) {
    await expect(stats.getByText(label, { exact: true }).locator('..').locator('strong')).toHaveText(`${value} шт.`)
  }
}

async function exportBackup(page: Page) {
  const pendingDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Экспорт JSON' }).click()
  const download = await pendingDownload
  expect(download.suggestedFilename()).toMatch(/\.json$/)
  const path = await download.path()
  return { path, backup: JSON.parse(await readFile(path, 'utf8')) as BackupData }
}

test('производственный цикл с нуля: выпуск, FIFO, архив и восстановление', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.clock.setFixedTime(new Date(`${shiftDate}T10:00:00`))
  await page.goto('/')

  await test.step('Войти по паролю и завести двух сотрудников', async () => {
    await unlock(page)
    await goTo(page, 'Сотрудники')
    for (const employee of employees) await addEmployee(page, employee)
  })

  await test.step('Зарегистрировать лоты, разделить первый и проверить выход и дегазацию', async () => {
    await goTo(page, 'Лоты')
    for (const [index, lot] of lots.entries()) {
      await page.getByRole('button', { name: 'Новый лот' }).click()
      const dialog = page.getByRole('dialog', { name: 'Новый лот' })
      await dialog.getByLabel('Страна', { exact: true }).fill(lot.country)
      await dialog.getByLabel('Название лота').fill(lot.name)
      await dialog.getByLabel('Дата обжарки').fill(roastDate)
      await dialog.getByLabel('Вес после обжарки, кг').fill(lot.weight)
      await dialog.getByLabel('Назначение 1', { exact: true }).selectOption({ label: '×16' })
      if (index === 0) {
        await dialog.getByRole('button', { name: 'Добавить назначение' }).click()
        await dialog.getByLabel('Вес 1', { exact: true }).fill('0.242')
        await dialog.getByLabel('Назначение 2', { exact: true }).selectOption({ label: '×6' })
        await dialog.getByLabel('Вес 2', { exact: true }).fill('0.0484')
        await expect(dialog.getByText('≈ 20 шт.', { exact: true })).toBeVisible()
        await expect(dialog.getByText('≈ 4 шт.', { exact: true })).toBeVisible()
      }
      await dialog.getByRole('button', { name: 'Создать лот и задачи' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('rowheader', { name: lotLabel(lot) })).toBeVisible()
    }
    await goTo(page, 'Календарь')
    const readyDay = page.locator('.calendar-week .surface').filter({ has: page.locator(`time[datetime="${shiftDate}"]`) })
    await expect(readyDay.getByText(lotLabel(lots[0]), { exact: true })).toHaveCount(1)
    await goTo(page, 'Производство')
    const groupedTask = page.locator('.production-task').filter({ has: page.getByRole('heading', { name: lotLabel(lots[0]), exact: true }) })
    await expect(groupedTask).toHaveCount(1)
    await expect(groupedTask).toContainText('24 шт.')
  })

  await test.step('Выпустить сначала 3 дрипа, проверить приход и выпустить остаток', async () => {
    await produce(page, lots[0], 3)
    await page.getByRole('link', { name: 'Открыть партии на стоке' }).click()
    await expectStock(page, 3, 0)
    await page.getByRole('button', { name: `История партии ${lotLabel(lots[0])}` }).click()
    const batch = page.getByRole('dialog', { name: lotLabel(lots[0]) })
    await expect(batch.getByText('Приход', { exact: true })).toBeVisible()
    await expect(batch.getByText('+3', { exact: true })).toBeVisible()
    await batch.getByRole('button', { name: 'Закрыть' }).click()

    await page.clock.setFixedTime(new Date(`${shiftDate}T10:01:00`))
    await goTo(page, 'Производство')
    await produce(page, lots[0], 17)
    await page.clock.setFixedTime(new Date(`${shiftDate}T10:02:00`))
    await produce(page, lots[0], 4)
    for (const [index, lot] of lots.slice(1).entries()) await produce(page, lot, index === 2 ? 16 : 20)
    await goTo(page, 'Сток')
    await expectStock(page, 80, 0)
  })

  await test.step('Импортировать состав ×16 из CSV, сопоставить псевдоним и подтвердить план', async () => {
    await goTo(page, 'Составы')
    await page.getByRole('button', { name: 'Google Sheets', exact: true }).click()
    const importedLots = ['Эфиопия / Гуджи (экспорт)', ...lots.slice(1).map(lotLabel)]
    const csv = [`Набор,${setName}`, ...importedLots.map((name, index) => `Страна ${index + 1} / локация ${index + 1},${name}`)].join('\n')
    await page.getByLabel('CSV-данные').fill(csv)
    await page.getByRole('button', { name: 'Импортировать CSV' }).click()
    await expect(page.getByText('Импортировано: 1', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Все составы/ }).click()
    await page.getByRole('button', { name: `Открыть состав ${setName}` }).click()
    const composition = page.getByRole('dialog', { name: setName })
    await expect(composition.getByText(/Нет сопоставления/)).toBeVisible()
    await composition.getByLabel('Сопоставить Гуджи (экспорт)').selectOption({ label: lotLabel(lots[0]) })
    await expect(composition.getByText(/Нет сопоставления/)).toHaveCount(0)
    await expect(composition.getByText('4 наб.', { exact: true })).toBeVisible()
    await composition.getByRole('button', { name: 'Закрыть' }).click()

    await goTo(page, 'Сборка')
    await page.getByRole('button', { name: 'План', exact: true }).click()
    const capacity = page.getByLabel(`Количество ${setName}`, { exact: true })
    await expect(capacity).toHaveAttribute('max', '4')
    await capacity.fill('4')
    await page.getByRole('button', { name: 'В план', exact: true }).click()
    await page.getByRole('button', { name: 'Сформировать план' }).click()
    await page.getByRole('button', { name: 'Подтвердить резерв' }).click()
    await expect(page.getByText('Подтверждено', { exact: true })).toBeVisible()
    await goTo(page, 'Сток')
    await expectStock(page, 80, 64)
  })

  await test.step('Отчёты двух сборщиков списывают сток и сохраняют оставшийся резерв', async () => {
    await page.getByRole('button', { name: 'Выйти', exact: true }).click()
    await goTo(page, 'Сборка')
    for (const employee of employees) {
      await page.getByRole('button', { name: 'Отчитаться' }).click()
      const report = page.getByRole('dialog', { name: `Отчёт: ${setName}` })
      await report.getByLabel('Сборщик').selectOption({ label: employeeLabel(employee) })
      await report.getByLabel('Фактически собрано наборов').fill('1')
      await report.getByRole('button', { name: 'Отправить отчёт' }).click()
      await expect(report).toHaveCount(0)
    }
    await expect(page.getByText('Осталось 2 наб.', { exact: true })).toBeVisible()
    await goTo(page, 'Сток')
    await expectStock(page, 48, 32)
  })

  await test.step('Закрыть день с переносом, открыть архив и перезагрузить страницу', async () => {
    await unlock(page)
    await goTo(page, 'Отчёты')
    await expect(page.getByText('Собрано 2 из 4', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^Завершить (?:производственный )?день$/ }).click()
    const close = page.getByRole('dialog', { name: 'Завершить производственный день?' })
    await expect(close).toContainText('10.10.2025')
    await close.getByRole('button', { name: 'Подтвердить завершение' }).click()
    const confirmTransfer = page.getByRole('button', { name: 'Завершить и перенести остатки' })
    await confirmTransfer.click()
    await expect(page.getByRole('button', { name: 'День завершён' })).toBeDisabled()
    await page.reload()
    const archiveEntry = page.getByRole('button', { name: /09\.10\.2025.*Выпущено: 80 шт\..*Собрано: 2 наб\./s })
    await archiveEntry.click()
    const archive = page.getByRole('dialog', { name: 'Архивный отчёт за 09.10.2025' })
    await expect(archive.getByText('Собрано 2 из 4', { exact: true })).toBeVisible()
    for (const employee of employees) await expect(archive.getByText(employeeLabel(employee), { exact: false }).last()).toBeVisible()
    await archive.getByRole('button', { name: 'Закрыть' }).click()
    await goTo(page, 'Сток')
    await expectStock(page, 48, 32)
  })

  await test.step('Экспортировать данные, проверить детали FIFO и восстановить резервную копию через интерфейс', async () => {
    await page.goto('/admin')
    await page.getByRole('button', { name: 'Резервные копии' }).click()
    const { path, backup } = await exportBackup(page)
    const { data } = backup
    const inventory = data.inventory as InventoryLot[]
    const reports = data.assemblyReports as AssemblyReport[]
    const staff = data.employees as Employee[]
    const reservations = data.reservations as StockReservation[]
    const transactions = data.inventoryTransactions as InventoryTransaction[]
    const tasks = data.assemblyTasks as AssemblyTask[]
    expect(reports).toHaveLength(2)
    const firstCoffee = inventory.filter((batch) => batch.coffeeName === lots[0].name && batch.purpose === '×16').sort((left, right) => left.manufacturedAt.localeCompare(right.manufacturedAt))
    expect(firstCoffee).toHaveLength(2)
    const [older, newer] = firstCoffee
    expect(older.manufacturedAt < newer.manufacturedAt).toBe(true)
    const initialReport = reports.find((report) => report.employeeId === staff.find((person) => person.lastName === employees[0].last)?.id)
    const followUpReport = reports.find((report) => report.employeeId === staff.find((person) => person.lastName === employees[1].last)?.id)
    const fromFirstCoffee = (report?: AssemblyReport) => report?.deductions.filter((deduction) => [older.id, newer.id].includes(deduction.inventoryLotId))
    expect(fromFirstCoffee(initialReport)).toEqual([
      expect.objectContaining({ inventoryLotId: older.id, quantity: 3 }),
      expect.objectContaining({ inventoryLotId: newer.id, quantity: 1 }),
    ])
    expect(fromFirstCoffee(followUpReport)).toEqual([expect.objectContaining({ inventoryLotId: newer.id, quantity: 4 })])
    for (const report of reports) {
      for (const deduction of report.deductions) {
        expect(reservations).toContainEqual(expect.objectContaining({ id: deduction.reservationId, inventoryLotId: deduction.inventoryLotId, assemblyTaskId: report.taskId }))
        expect(transactions).toContainEqual(expect.objectContaining({ reportId: report.id, inventoryLotId: deduction.inventoryLotId, quantity: -deduction.quantity }))
      }
    }
    expect(older).toMatchObject({ quantity: 0, reserved: 0 })
    expect(newer).toMatchObject({ quantity: 12, reserved: 8 })
    expect(reservations.filter((entry) => entry.status === 'active').reduce((sum, entry) => sum + entry.quantity - entry.consumedQuantity, 0)).toBe(32)
    expect(tasks).toContainEqual(expect.objectContaining({ name: setName, status: 'transferred', productionDate: '2025-10-10', completedQuantity: 2 }))
    expect(data.dailyReports).toHaveLength(1)
    expect(data.aliases).toHaveLength(1)

    await goTo(page, 'Сотрудники')
    const temporaryEmployee = { last: 'Временный', first: 'Сотрудник' }
    await addEmployee(page, temporaryEmployee)
    await page.goto('/admin')
    await page.getByRole('button', { name: 'Резервные копии' }).click()
    const input = page.locator('input[type=file]')
    await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{') })
    await expect(page.getByRole('alert')).toContainText('Некорректная копия')
    await input.setInputFiles(path)
    const preview = page.getByRole('dialog', { name: 'Предварительный просмотр импорта' })
    const employeeCounts = preview.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Сотрудники', exact: true }) })
    await expect(employeeCounts.getByRole('cell')).toHaveText(['3', '2'])
    await preview.getByRole('button', { name: 'Заменить данные' }).click()
    await expect(preview).toHaveCount(0)
    await expect(page.getByText('Резервная копия восстановлена', { exact: true })).toBeVisible()
    expect((await exportBackup(page)).backup.data).toEqual(data)
    await goTo(page, 'Сотрудники')
    await expect(page.getByRole('rowheader', { name: employeeLabel(temporaryEmployee) })).toHaveCount(0)
    await expect(page.getByRole('rowheader', { name: employeeLabel(employees[0]) })).toBeVisible()
  })

  expect(errors).toEqual([])
})
