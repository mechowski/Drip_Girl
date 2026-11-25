import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { AssemblyReport, AssemblyTask, BackupData, Employee, InventoryLot, InventoryTransaction, StockReservation } from '../src/domain/types'

test.use({ reducedMotion: 'reduce' })

const roastDate = '2025-10-06'
const shiftDate = '2025-10-09'
const setName = 'Дегустационный набор'
const secondSetName = 'Второй дегустационный набор'
const thirdSetName = 'Третий дегустационный набор'
const lots = [
  { country: 'Эфиопия', name: 'Гуджи', weight: '0.5324' },
  { country: 'Колумбия', name: 'Уила', weight: '0.5808' },
  { country: 'Бразилия', name: 'Серрадо', weight: '0.5808' },
  { country: 'Кения', name: 'Ньери', weight: '0.5808' },
]
const employees = [
  { last: 'Иванова', first: 'Анна' },
  { last: 'Петров', first: 'Максим' },
]
const lotLabel = ({ country, name }: (typeof lots)[number]) => `${country} / ${name}`
const employeeLabel = ({ last, first }: (typeof employees)[number]) => `${last} ${first}`
const goTo = (page: Page, name: string) => page.getByRole('link', { name, exact: true }).click()

async function unlock(page: Page) {
  await page.getByRole('button', { name: 'Режим администратора', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Режим администратора', exact: true })).toHaveAttribute('aria-pressed', 'true')
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
  const task = page.locator('.lot-panel').filter({ has: page.getByRole('heading', { name: lotLabel(lot), exact: true }) }).locator('.production-task')
    .filter({ has: page.getByRole('heading', { name: '×16', exact: true, level: 4 }) })
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

  await test.step('Включить режим администратора и завести двух сотрудников', async () => {
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
        await dialog.getByLabel('Вес 1', { exact: true }).fill('0.484')
        await dialog.getByLabel('Назначение 2', { exact: true }).selectOption({ label: '×6' })
        await dialog.getByLabel('Вес 2', { exact: true }).fill('0.0484')
        await expect(dialog.getByText('≈ 40 шт.', { exact: true })).toBeVisible()
        await expect(dialog.getByText('≈ 4 шт.', { exact: true })).toBeVisible()
      }
      await dialog.getByRole('button', { name: 'Создать лот и задачи' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('rowheader', { name: lotLabel(lot) })).toBeVisible()
    }
    await goTo(page, 'Календарь')
    await page.getByRole('button', { name: '9 октября 2025, событий: 5' }).click()
    const datePlan = page.getByRole('dialog', { name: 'План на 9 октября' })
    await expect(datePlan.getByRole('link', { name: new RegExp(lotLabel(lots[0])) })).toHaveCount(2)
    await page.keyboard.press('Escape')
    await goTo(page, 'Производство')
    const lotTasks = page.locator('.lot-panel').filter({ has: page.getByRole('heading', { name: lotLabel(lots[0]), exact: true }) }).locator('.production-task')
    await expect(lotTasks).toHaveCount(2)
    await expect(lotTasks.filter({ hasText: '×16' })).toContainText('40 шт.')
    await expect(lotTasks.filter({ hasText: '×6' })).toContainText('4 шт.')
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
    await produce(page, lots[0], 37)
    await page.clock.setFixedTime(new Date(`${shiftDate}T10:02:00`))
    for (const lot of lots.slice(1)) await produce(page, lot, 48)
    await goTo(page, 'Сток')
    await expectStock(page, 184, 0)
  })

  await test.step('Импортировать состав ×16 из CSV, сопоставить псевдоним и подтвердить план', async () => {
    await goTo(page, 'Составы')
    await page.getByRole('button', { name: 'Google Sheets', exact: true }).click()
    const importedLots = ['Эфиопия / Гуджи (экспорт)', ...lots.slice(1).map(lotLabel)]
    const csv = [`Набор,${setName},${secondSetName},${thirdSetName}`, ...importedLots.map((name, index) => `Страна ${index + 1} / локация ${index + 1},${name},${lotLabel(lots[index])},${lotLabel(lots[index])}`)].join('\n')
    await page.getByLabel('CSV-данные').fill(csv)
    await page.getByRole('button', { name: 'Импортировать CSV' }).click()
    await expect(page.getByText('Импортировано: 3', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Все составы/ }).click()
    await page.getByRole('button', { name: `Открыть состав ${setName}` }).click()
    const composition = page.getByRole('dialog', { name: setName })
    await expect(composition.getByText(/Нет сопоставления/)).toBeVisible()
    await composition.getByLabel('Сопоставить Гуджи (экспорт)').selectOption({ label: lotLabel(lots[0]) })
    await expect(composition.getByText(/Нет сопоставления/)).toHaveCount(0)
    await expect(composition.getByText('10 наб.', { exact: true })).toBeVisible()
    await composition.getByRole('button', { name: 'Закрыть' }).click()

    await goTo(page, 'Сборка')
    await page.getByRole('button', { name: 'План', exact: true }).click()
    const card = (name: string) => page.locator('.surface').filter({ has: page.getByRole('heading', { name, exact: true }) })
    const quantity = page.getByLabel(`Количество ${setName}`, { exact: true })
    const secondQuantity = page.getByLabel(`Количество ${secondSetName}`, { exact: true })
    await expect(card(setName)).toContainText('10 наборов доступно')
    await quantity.fill('8')
    await card(setName).getByRole('button', { name: 'В план', exact: true }).click()
    await secondQuantity.fill('4')
    await expect(card(secondSetName).getByRole('status')).toHaveText('Доступно 2 из 4 наборов')
    await card(secondSetName).getByRole('button', { name: 'В план', exact: true }).click()
    await quantity.fill('6')
    await expect(card(secondSetName)).toContainText('4 наборов доступно')
    await expect(card(secondSetName).getByRole('status')).toBeHidden()
    await quantity.fill('8')
    await page.getByRole('button', { name: 'Сформировать план' }).click()
    await expect(page.getByRole('button', { name: 'Подтвердить резерв' })).toBeDisabled()
    await goTo(page, 'Сток')
    await expectStock(page, 184, 0)

    await goTo(page, 'Сборка')
    await page.getByRole('button', { name: 'План', exact: true }).click()
    await expect(page.getByText('Доступно 2 из 4 наборов', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Пересчитать план' }).click()
    await expect(secondQuantity).toHaveValue('4')
    await page.getByText(`${secondSetName} · 4 наб.`, { exact: true }).locator('..').getByRole('button', { name: 'Убрать' }).click()
    await expect(card(setName)).toContainText('10 наборов доступно')
    await quantity.fill('4')
    await page.getByRole('button', { name: 'Сохранить пересчёт' }).click()
    await page.getByRole('button', { name: 'Подтвердить резерв' }).click()
    await expect(page.getByText('Подтверждено', { exact: true })).toBeVisible()
    await goTo(page, 'Сегодня')
    await page.getByRole('button', { name: '9 октября 2025, задач: 6' }).click()
    const dayPlan = page.getByRole('dialog', { name: 'План на 9 октября' })
    await expect(dayPlan.getByRole('heading', { name: lotLabel(lots[0]), exact: true })).toHaveCount(1)
    await expect(dayPlan.getByRole('link', { name: new RegExp(lotLabel(lots[0])) })).toHaveCount(2)
    await expect(dayPlan.getByRole('link', { name: `Открыть: ${setName} · Сборка`, exact: true })).toHaveAttribute('href', /assembly#task-/)
    await dayPlan.getByRole('link', { name: 'Открыть день в календаре' }).click()
    await expect(page).toHaveURL(/calendar\?date=2025-10-09$/)
    await expect(page.getByRole('heading', { name: 'Неделя производства' })).toHaveCount(0)
    const monthPlan = page.getByRole('dialog', { name: 'План на 9 октября' })
    await expect(monthPlan).toBeVisible()
    await monthPlan.getByRole('link', { name: `Открыть: ${setName} · Сборка`, exact: true }).click()
    const assembly = page.getByRole('dialog', { name: setName })
    await expect(assembly.getByRole('button', { name: 'Отчитаться' })).toBeVisible()
    await expect(page).toHaveURL(/calendar\?date=2025-10-09$/)
    await page.keyboard.press('Escape')
    await expect(assembly).toHaveCount(0)
    await expect(monthPlan).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(monthPlan).toHaveCount(0)
    await goTo(page, 'Сток')
    await expectStock(page, 184, 64)
    await page.getByLabel('Поиск по стоку').fill(lots[0].name)
    await page.getByLabel('Назначение', { exact: true }).selectOption('×16')
    await expectStock(page, 40, 16)
    await goTo(page, 'Сборка')
    await page.getByRole('button', { name: 'План', exact: true }).click()
    await expect(card(secondSetName)).toContainText('6 наборов доступно')
  })

  await test.step('Отчёты двух сборщиков списывают сток и сохраняют оставшийся резерв', async () => {
    await page.getByRole('button', { name: 'Режим администратора', exact: true }).click()
    await goTo(page, 'Сборка')
    for (const [index, employee] of employees.entries()) {
      await page.getByRole('button', { name: 'Отчитаться' }).click()
      const report = page.getByRole('dialog', { name: `Отчёт: ${setName}` })
      await report.getByLabel('Сборщик').selectOption({ label: employeeLabel(employee) })
      await report.getByLabel('Фактически собрано наборов').fill(String(index + 1))
      await report.getByRole('button', { name: 'Отправить отчёт' }).click()
      await expect(report).toHaveCount(0)
    }
    await expect(page.getByText('Осталось 1 наб.', { exact: true })).toBeVisible()
    await goTo(page, 'Сток')
    await expectStock(page, 136, 16)
  })

  await test.step('Внести недостающий факт и закрыть день с разными решениями по остаткам', async () => {
    await goTo(page, 'Отчёты')
    await expect(page.getByRole('button', { name: /^Завершить производственный день$/ })).toHaveCount(0)
    await unlock(page)
    await goTo(page, 'Сборка')
    await page.getByRole('button', { name: 'План', exact: true }).click()
    const addToPlan = async (name: string, quantity: number) => {
      const card = page.locator('.surface').filter({ has: page.getByRole('heading', { name, exact: true }) })
      await card.getByRole('spinbutton').fill(String(quantity))
      await card.getByRole('button', { name: 'В план', exact: true }).click()
    }
    await addToPlan(secondSetName, 4)
    await page.getByRole('checkbox', { name: 'Совместная сборка' }).check()
    await addToPlan(thirdSetName, 1)
    await page.getByRole('button', { name: 'Сформировать план' }).click()
    await page.getByRole('button', { name: 'Подтвердить резерв' }).click()
    await expect(page.getByRole('heading', { name: thirdSetName, exact: true })).toBeVisible()

    await goTo(page, 'Отчёты')
    await page.setViewportSize({ width: 375, height: 812 })
    await page.getByRole('button', { name: /^Завершить производственный день$/ }).click()
    const close = page.getByRole('dialog', { name: 'Завершить производственный день?' })
    const confirm = close.getByRole('button', { name: 'Подтвердить завершение' })
    const secondTask = close.getByRole('group', { name: secondSetName, exact: true })
    const thirdTask = close.getByRole('group', { name: thirdSetName, exact: true })
    await expect(close).toContainText('10.10.2025')
    await expect(confirm).toBeDisabled()
    for (const name of [setName, secondSetName, thirdSetName]) {
      await expect(close.getByRole('group', { name, exact: true }).getByRole('checkbox', { name: 'Перенести на следующий рабочий день' })).toBeChecked()
    }
    await secondTask.getByLabel('Факт за эту смену').selectOption('positive')
    for (const employee of employees) await secondTask.getByRole('checkbox', { name: employeeLabel(employee) }).check()
    await secondTask.getByLabel('Фактически собрано наборов').fill('3')
    await secondTask.getByRole('checkbox', { name: 'Перенести на следующий рабочий день' }).uncheck()
    await expect(confirm).toBeDisabled()
    await thirdTask.getByLabel('Факт за эту смену').selectOption('zero')
    await thirdTask.getByRole('checkbox', { name: 'Перенести на следующий рабочий день' }).uncheck()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
    await confirm.click()
    await expect(page.getByRole('button', { name: 'День завершён' })).toBeDisabled()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload()
    const archiveEntry = page.getByRole('button', { name: /09\.10\.2025.*Выпущено: 184 шт\..*Собрано: 6 наб\./s })
    await archiveEntry.click()
    const archive = page.getByRole('dialog', { name: 'Архивный отчёт за 09.10.2025' })
    await expect(archive.getByRole('heading', { name: 'Изготовление' })).toBeVisible()
    await expect(archive.getByRole('heading', { name: 'Сборка' })).toBeVisible()
    const lotTotal = archive.locator('.history-line').filter({ has: page.getByText(lotLabel(lots[0]), { exact: true }) })
    await expect(lotTotal).toHaveCount(1)
    await expect(lotTotal.getByText('40 шт.', { exact: true })).toBeVisible()
    await expect(archive.getByText('Собрано 3 из 4', { exact: true })).toHaveCount(2)
    await expect(archive.getByText('Собрано 0 из 1', { exact: true })).toBeVisible()
    for (const employee of employees) await expect(archive.getByText(employeeLabel(employee), { exact: false })).toHaveCount(0)
    await archive.getByRole('button', { name: 'Закрыть' }).click()
    await page.goto('/calendar?date=2025-10-10')
    const nextShift = page.getByRole('dialog', { name: 'План на 10 октября' })
    await expect(nextShift.getByRole('link', { name: `Открыть: ${setName} · Сборка`, exact: true })).toBeVisible()
    await expect(nextShift.getByText('1 наб.', { exact: true })).toBeVisible()
    await nextShift.getByRole('button', { name: 'Закрыть', exact: true }).click()
    await goTo(page, 'Сток')
    await expectStock(page, 88, 16)
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
    expect(reports).toHaveLength(4)
    const firstCoffee = inventory.filter((batch) => batch.coffeeName === lots[0].name && batch.purpose === '×16').sort((left, right) => left.manufacturedAt.localeCompare(right.manufacturedAt))
    expect(firstCoffee).toHaveLength(2)
    const [older, newer] = firstCoffee
    expect(older.manufacturedAt < newer.manufacturedAt).toBe(true)
    const initialReport = reports.find((report) => !report.recordedBy && report.employeeId === staff.find((person) => person.lastName === employees[0].last)?.id)
    const followUpReport = reports.find((report) => !report.recordedBy && report.employeeId === staff.find((person) => person.lastName === employees[1].last)?.id)
    const fromFirstCoffee = (report?: AssemblyReport) => report?.deductions.filter((deduction) => [older.id, newer.id].includes(deduction.inventoryLotId))
    expect(fromFirstCoffee(initialReport)).toEqual([
      expect.objectContaining({ inventoryLotId: older.id, quantity: 3 }),
      expect.objectContaining({ inventoryLotId: newer.id, quantity: 1 }),
    ])
    expect(fromFirstCoffee(followUpReport)).toEqual([expect.objectContaining({ inventoryLotId: newer.id, quantity: 8 })])
    for (const report of reports) {
      for (const deduction of report.deductions) {
        expect(reservations).toContainEqual(expect.objectContaining({ id: deduction.reservationId, inventoryLotId: deduction.inventoryLotId, assemblyTaskId: report.taskId }))
        expect(transactions).toContainEqual(expect.objectContaining({ reportId: report.id, inventoryLotId: deduction.inventoryLotId, quantity: -deduction.quantity }))
      }
    }
    expect(older).toMatchObject({ quantity: 0, reserved: 0 })
    expect(newer).toMatchObject({ quantity: 16, reserved: 4 })
    expect(reservations.filter((entry) => entry.status === 'active').reduce((sum, entry) => sum + entry.quantity - entry.consumedQuantity, 0)).toBe(16)
    expect(tasks).toContainEqual(expect.objectContaining({ name: setName, status: 'transferred', productionDate: '2025-10-10', completedQuantity: 3 }))
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

test('согласует выпуск для резерва и закрывает дефицит после раннего отчёта', async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${shiftDate}T10:00:00`))
  await page.goto('/')
  await unlock(page)
  await goTo(page, 'Сотрудники')
  for (const employee of employees) await addEmployee(page, employee)

  const lot = lots[0]
  await goTo(page, 'Лоты')
  await page.getByRole('button', { name: 'Новый лот' }).click()
  const newLot = page.getByRole('dialog', { name: 'Новый лот' })
  await newLot.getByLabel('Страна', { exact: true }).fill(lot.country)
  await newLot.getByLabel('Название лота').fill(lot.name)
  await newLot.getByLabel('Дата обжарки').fill(roastDate)
  await newLot.getByLabel('Вес после обжарки, кг').fill('0.2904')
  await newLot.getByRole('button', { name: 'Создать лот и задачи' }).click()
  await expect(newLot).toHaveCount(0)
  await goTo(page, 'Производство')
  await produce(page, lot, 4)
  await goTo(page, 'Составы')
  await page.getByRole('button', { name: 'Ручной состав' }).click()
  await page.getByLabel('Лот состава 1', { exact: true }).selectOption({ label: lotLabel(lot) })
  await page.getByRole('button', { name: 'Сохранить состав' }).click()
  await expect(page.getByText('Состав сохранён')).toBeVisible()

  await goTo(page, 'Сборка')
  await page.getByRole('button', { name: 'План', exact: true }).click()
  await page.getByRole('spinbutton', { name: /Количество .*Гуджи/ }).fill('2')
  await page.getByRole('button', { name: 'В план', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Совместная сборка' }).check()
  await page.getByRole('button', { name: 'Сформировать план' }).click()
  await expect(page.getByText(/не хватает 8 шт\./)).toBeVisible()
  await page.getByRole('button', { name: 'Согласовать резерв под выпуск' }).click()
  const consent = page.getByRole('dialog', { name: 'Согласовать резерв под ожидаемый выпуск' })
  await expect(consent.getByRole('link', { name: /Эфиопия \/ Гуджи/ })).toBeVisible()
  await consent.getByRole('button', { name: 'Закрыть', exact: true }).click()
  await goTo(page, 'Сток')
  await expectStock(page, 4, 0)

  await goTo(page, 'Сборка')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: 'План', exact: true }).click()
  await page.getByRole('button', { name: 'Согласовать резерв под выпуск' }).click()
  await expect(consent).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
  await consent.getByRole('button', { name: 'Подтвердить резерв под ожидаемый выпуск' }).click()
  await expect(page.getByText('Под ожидаемый выпуск', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await goTo(page, 'Сток')
  await expectStock(page, 4, 4)
  await page.getByText('Ожидаемый выпуск на сегодня', { exact: true }).click()
  await expect(page.getByText('Свободно по плану 12 шт. · Уже обещано 8 шт.')).toBeVisible()

  await page.getByRole('button', { name: 'Режим администратора', exact: true }).click()
  await goTo(page, 'Сборка')
  await expect(page.getByRole('button', { name: 'План', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Отчитаться' }).click()
  await expect(page.getByText(/спишутся при его внесении на сток/)).toBeVisible()
  const submit = page.getByRole('button', { name: 'Отправить отчёт' })
  await page.getByRole('checkbox', { name: employeeLabel(employees[0]) }).check()
  await expect(submit).toBeDisabled()
  await page.getByRole('checkbox', { name: employeeLabel(employees[1]) }).check()
  await expect(submit).toBeEnabled()
  await page.getByLabel('Фактически собрано наборов').fill('2')
  await submit.click()
  await expect(page.getByText('Выполнено', { exact: true })).toBeVisible()
  await page.getByText('Отчётов 1', { exact: true }).click()
  await expect(page.getByText(`${employees.map(employeeLabel).join(', ')} · 2 наб.`)).toBeVisible()
  await goTo(page, 'Сток')
  await expectStock(page, 0, 0)

  await unlock(page)
  await goTo(page, 'Производство')
  await produce(page, lot, 20)
  await goTo(page, 'Сток')
  await expectStock(page, 12, 0)
  await goTo(page, 'Сборка')
  await expect(page.getByText('Под ожидаемый выпуск', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Выполнено', { exact: true })).toBeVisible()
})
