import { expect, test } from '@playwright/test'

test('мобильные разделы смены, справочник и проверка копии', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 860 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/today')
  await page.getByRole('button', { name: 'Администратор' }).click()
  await page.getByLabel('Пароль').fill('1337')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()

  await page.goto('/compositions')
  await expect(page.getByRole('heading', { name: 'Нет составов' })).toBeVisible()
  await page.goto('/calendar')
  await expect(page.getByRole('heading', { name: 'Календарь пуст' })).toBeVisible()

  await page.goto('/admin')
  await page.getByRole('button', { name: 'Заполнить тестовыми данными' }).click()
  await expect(page.getByText('Демонстрационные лоты, сток и состав добавлены')).toBeVisible()
  await page.getByRole('button', { name: 'Резервные копии' }).click()
  await page.locator('input[type=file]').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, exportedAt: '2025-10-06T12:00:00Z', data: { lots: [{ name: 'Без ключа' }] } })),
  })
  await expect(page.getByRole('alert')).toContainText('без идентификатора')
  await expect(page.getByRole('button', { name: 'Заменить данные' })).toHaveCount(0)

  await page.goto('/employees')
  await page.getByRole('searchbox').fill('Петрова')
  const employee = page.getByRole('row', { name: /Петрова Мария/ })
  await expect(employee).toBeVisible()
  await expect(page.getByRole('row', { name: /Иванова Анна/ })).toHaveCount(0)
  await employee.getByRole('button', { name: 'Отключить' }).click()
  const disable = page.getByRole('dialog')
  await expect(disable.getByText(/Прошлые отчёты сотрудника сохранятся/)).toBeVisible()
  await disable.getByRole('button', { name: 'Отключить' }).click()
  await expect(employee.getByText('Отключён', { exact: true })).toBeVisible()

  await page.goto('/')
  await page.getByRole('button', { name: /Открыть лот Эфиопия/ }).click()
  const lot = page.getByRole('dialog')
  await expect(lot.getByRole('heading', { name: 'Связанные задачи' })).toBeVisible()
  await expect(lot.getByRole('link')).toHaveAttribute('href', /\/production\?task=/)

  await page.goto('/compositions')
  await page.getByRole('button', { name: /Открыть состав Восточная коллекция/ }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Ингредиенты и сток' })).toBeVisible()
  await expect(page.getByRole('dialog').getByText('Партий на стоке: 1')).toHaveCount(4)

  for (const [path, heading] of [['/', 'Лоты кофе'], ['/assembly', 'Сборка'], ['/calendar', 'Календарь'], ['/compositions', 'Составы наборов'], ['/reports', 'Отчёты'], ['/employees', 'Сотрудники'], ['/admin', 'Админпанель']]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBe(390)
  }
  expect(errors).toEqual([])
})

test('Google Sheets показывает загрузку, успешное обновление и ошибку', async ({ page }) => {
  const workbook = 'https://docs.google.com/spreadsheets/d/drip_fixture'
  const name = 'Восточная коллекция ферментированных лотов для дегустации'
  let failExport = false
  let revealSheets = () => {}
  const sheetsReady = new Promise<void>((resolve) => { revealSheets = resolve })
  await page.route(`${workbook}/**`, async (route) => {
    if (route.request().url().endsWith('/htmlview')) {
      await sheetsReady
      await route.fulfill({ contentType: 'text/html', body: '{name:"Коллекция ×16", gid:1}' })
    } else if (failExport) {
      await route.fulfill({ status: 503, body: 'Unavailable' })
    } else {
      await route.fulfill({ contentType: 'text/csv', body: `Набор,${name}\nСтрана 1 / локация 1,Эфиопия / Гуджи\nСтрана 2 / локация 2,Колумбия / Уила\nСтрана 3 / локация 3,Бразилия / Серрадо\nСтрана 4 / локация 4,Кения / Ньери` })
    }
  })
  await page.setViewportSize({ width: 390, height: 860 })
  await page.goto('/compositions')
  await page.getByRole('button', { name: 'Администратор' }).click()
  await page.getByLabel('Пароль').fill('1337')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('button', { name: 'Google Sheets', exact: true }).click()
  await page.getByLabel('Ссылка на таблицу').fill(workbook)
  await page.getByRole('button', { name: 'Получить листы' }).click()
  try {
    await expect(page.getByRole('button', { name: 'Загрузка…' })).toBeDisabled()
  } finally {
    revealSheets()
  }
  await page.getByRole('heading', { name: 'Листы для импорта' }).waitFor()
  await page.getByRole('button', { name: 'Обновить составы' }).click()
  await expect(page.getByText(/Последнее успешное обновление: \d/)).toBeVisible()
  failExport = true
  await page.getByRole('button', { name: 'Обновить составы' }).click()
  await expect(page.getByText(/Ошибка обновления:.*503/)).toBeVisible()
  await page.getByRole('button', { name: /^Все составы/ }).click()
  await expect(page.getByRole('rowheader', { name })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})
