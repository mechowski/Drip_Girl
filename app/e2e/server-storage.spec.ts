import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const base = process.env.DRIP_SERVER_TEST_URL
const operatorPassword = process.env.DRIP_OPERATOR_PASSWORD
const adminPassword = process.env.DRIP_ADMIN_PASSWORD
test.skip(!base || !operatorPassword || !adminPassword, 'Требуется отдельная пустая БД Docker для приёмки')
test.use({ baseURL: base })

async function login(page: Page, role: string, password: string) {
  await page.goto('/')
  await page.getByRole('combobox').selectOption(role)
  await page.getByLabel('Пароль').fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Лоты', exact: true })).toBeVisible()
}

function command(request: APIRequestContext, name: string, args: unknown[] = [], key = randomUUID()) {
  return request.post('/api/repository/command/' + name, {
    data: args, headers: { Origin: new URL(base!).origin, 'Idempotency-Key': key },
  })
}

test('два профиля видят выпуск, а последний остаток резервируется один раз', async ({ browser }) => {
  const operator = await browser.newContext({ baseURL: base })
  const admin = await browser.newContext({ baseURL: base })
  try {
    const first = await operator.newPage()
    const second = await admin.newPage()
    await login(first, 'operator', operatorPassword!)
    await login(second, 'admin', adminPassword!)
    const employeeName = randomUUID().slice(0, 10)
    const empty = await (await command(admin.request, 'exportServerBackup')).json()
    expect(empty.schemaVersion).toBe(8)
    expect((await command(operator.request, 'importServerBackup', [empty])).status()).toBe(403)
    expect((await command(admin.request, 'importServerBackup', [{ ...empty, data: {} }])).status()).toBe(422)
    const importKey = randomUUID()
    expect((await command(admin.request, 'importServerBackup', [empty], importKey)).status()).toBe(200)
    expect((await command(admin.request, 'importServerBackup', [empty], importKey)).status()).toBe(200)
    expect((await command(admin.request, 'importServerBackup', [empty])).status()).toBe(422)

    await first.getByRole('button', { name: 'Режим администратора' }).click()
    await first.getByRole('dialog', { name: 'Доступ администратора' }).getByLabel('Пароль').fill(adminPassword!)
    await first.getByRole('dialog', { name: 'Доступ администратора' }).getByRole('button', { name: 'Войти' }).click()
    await expect(first.getByRole('link', { name: 'Админпанель' })).toBeVisible()
    const employee = await command(admin.request, 'addEmployee', ['Тест', employeeName])
    expect(employee.status()).toBe(200)

    await first.getByRole('button', { name: 'Новый лот' }).click()
    const dialog = first.getByRole('dialog', { name: 'Новый лот' })
    await dialog.getByLabel('Страна', { exact: true }).fill('Приёмка')
    await dialog.getByLabel('Название лота').fill(employeeName)
    await dialog.getByLabel('Дата обжарки').fill('2025-10-06')
    await dialog.getByLabel('Вес после обжарки, кг').fill('0.121')
    await dialog.getByLabel('Назначение 1', { exact: true }).selectOption({ label: '×16' })
    await dialog.getByRole('button', { name: 'Создать лот и задачи' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(second.getByRole('rowheader', { name: 'Приёмка / ' + employeeName })).toBeVisible({ timeout: 12000 })

    const snapshot = await (await admin.request.get('/api/repository/snapshot')).json()
    const lot = snapshot.lots.find((row: { name: string }) => row.name === employeeName)
    const task = snapshot.productionTasks.find((row: { lotId: string }) => row.lotId === lot.id)
    const button = first.locator('.lot-panel').filter({ hasText: employeeName }).getByRole('button', { name: 'Внести выпуск' })
    await first.getByRole('link', { name: 'Производство', exact: true }).click()
    await button.click()
    const release = first.getByRole('dialog', { name: 'Внести выпуск' })
    await release.getByLabel('Фактическое количество, шт.').fill('10')
    await release.getByLabel('Ответственный').selectOption({ label: employeeName + ' Тест' })
    await release.getByRole('button', { name: 'Отправить на сток' }).click()
    await expect(release).toHaveCount(0)
    await second.getByRole('link', { name: 'Сток', exact: true }).click()
    await expect(second.getByText(employeeName, { exact: false }).first()).toBeVisible({ timeout: 12000 })

    const input = { id: randomUUID(), country: lot.country, coffeeName: lot.name, inventoryLotId: lot.id, formatId: 'drip', quantityPerSet: 1 }
    expect((await command(admin.request, 'addManualComposition', ['Проверка ' + employeeName, 'limit', [input]])).status()).toBe(200)
    const work = await (await admin.request.get('/api/repository/snapshot')).json()
    const composition = work.manualCompositions.find((row: { items: Array<{ inventoryLotId: string }> }) => row.items.some(item => item.inventoryLotId === lot.id))
    const firstPlan = await command(admin.request, 'createAssemblyPlan', [[{ composition, quantity: 10 }]])
    const secondPlan = await command(operator.request, 'createAssemblyPlan', [[{ composition, quantity: 10 }]])
    expect(firstPlan.status()).toBe(200)
    expect(secondPlan.status()).toBe(200)
    const plans = await Promise.all([firstPlan.json(), secondPlan.json()])
    const confirmed = await Promise.all([
      command(admin.request, 'confirmAssemblyPlan', [plans[0]]),
      command(operator.request, 'confirmAssemblyPlan', [plans[1]]),
    ])
    expect(confirmed.map(result => result.status()).sort()).toEqual([200, 422])
    const shared = await (await operator.request.get('/api/repository/snapshot')).json()
    expect(shared.productionEntries.find((row: { taskId: string }) => row.taskId === task.id).quantity).toBe(10)
    expect(shared.inventory.find((row: { sourceLotId: string }) => row.sourceLotId === lot.id).reserved).toBe(10)
    const winner = plans[confirmed.findIndex(result => result.ok())]
    const assembly = shared.assemblyTasks.find((row: { planId: string }) => row.planId === winner)
    const worker = await employee.json()
    expect((await command(admin.request, 'reportAssembly', [assembly.id, worker.id, 10])).status()).toBe(200)
    expect((await command(admin.request, 'closeProductionDay')).status()).toBe(200)
    const archived = await (await admin.request.get('/api/repository/snapshot')).json()
    expect(archived.dailyReports.some((row: { assembled: Array<{ taskId: string }> }) => row.assembled.some(entry => entry.taskId === assembly.id))).toBe(true)
    expect(archived.inventory.find((row: { sourceLotId: string }) => row.sourceLotId === lot.id).quantity).toBe(0)
    expect(shared.settings).not.toHaveProperty('adminPassword')
    expect(await first.evaluate(async () => (await indexedDB.databases()).map(database => database.name))).not.toContain('drip-girl-production')
  } finally {
    await Promise.all([operator.close(), admin.close()])
  }
})
