import { expect, test } from '@playwright/test'

test('новый состав выбирает выпущенный лот, сохранённый состав сохраняет привязку', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2025-10-09T12:00:00'))
  await page.goto('/')
  const button = (name: string) => page.getByRole('button', { name, exact: true })
  const link = (name: string) => page.getByRole('link', { name, exact: true })
  await button('Режим администратора').click()
  await link('Админпанель').click()
  await button('Заполнить тестовыми данными').click()
  await expect(page.getByText('Демонстрационные лоты, сток и состав добавлены')).toBeVisible()

  async function addLot(date: string) {
    await link('Лоты').click()
    await button('Новый лот').click()
    const form = page.getByRole('dialog', { name: 'Новый лот' })
    await form.getByLabel('Страна', { exact: true }).fill('Бразилия')
    await form.getByLabel('Название лота').fill('Перископ Мармелада')
    await form.getByLabel('Дата обжарки').fill(date)
    await form.getByLabel('Назначение 1').selectOption({ label: '×6' })
    await button('Создать лот и задачи').click()
    await expect(form).toHaveCount(0)
  }

  await addLot('2025-10-06')
  await link('Производство').click()
  const lotLabel = 'Бразилия / Перископ Мармелада'
  await page.locator('.lot-panel').filter({ has: page.getByRole('heading', { name: lotLabel }) })
    .getByRole('button', { name: 'Внести выпуск' }).click()
  await page.getByLabel('Фактическое количество, шт.').fill('6')
  await button('Отправить на сток').click()
  await button('Не списывать').click()

  await addLot('2025-10-09')
  await link('Составы').click()
  await button('Ручной состав').click()
  const select = page.getByLabel('Лот состава 1', { exact: true })
  await expect(select.getByRole('option', { name: /Перископ Мармелада/ })).toHaveCount(1)
  await select.selectOption({ label: lotLabel })
  const releasedId = await select.inputValue()
  await button('Сохранить состав').click()
  await expect(page.getByText('Состав сохранён')).toBeVisible()

  await link('Сток').click()
  await page.getByRole('button', { name: `История партии ${lotLabel}` }).click()
  await button('Списать').click()
  await page.getByLabel('Причина').fill('Тестовый расход стока')
  await button('Подтвердить списание').click()
  await expect(page.getByText('Продукция списана')).toBeVisible()

  await link('Составы').click()
  await page.getByRole('button', { name: /Открыть состав .*Перископ Мармелада/ }).click()
  await button('Редактировать состав').click()
  await expect(select).toHaveValue(releasedId)
  await expect(select.getByRole('option', { name: /Перископ Мармелада.*Нет доступного стока/ })).toHaveCount(1)
  await button('Сохранить состав').click()
  await expect(page.getByRole('dialog', { name: 'Редактирование состава' })).toHaveCount(0)
})
