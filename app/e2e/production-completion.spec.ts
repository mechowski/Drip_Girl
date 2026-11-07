import { test, expect } from '@playwright/test'

test('после изготовления предлагается списание и задача завершается', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('/')
  await page.getByRole('button', { name: 'Администратор' }).click()
  await page.getByLabel('Пароль').fill('1337')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('link', { name: 'Админпанель' }).click()
  await page.getByRole('button', { name: 'Заполнить тестовыми данными' }).click()
  await expect(page.getByText('Демонстрационные лоты, сток и состав добавлены')).toBeVisible()

  await page.getByRole('link', { name: 'Лоты', exact: true }).click()
  await page.getByRole('button', { name: 'Новый лот' }).click()
  await page.getByLabel('Страна').fill('Тестовая')
  await page.getByLabel('Название лота').fill('Финальная партия')
  await page.getByLabel('Вес после обжарки, кг').fill('1.21')
  await page.getByLabel('Вес 1').fill('1.21')
  await page.getByRole('button', { name: 'Создать лот и задачи' }).click()

  await page.getByRole('link', { name: 'Производство', exact: true }).click()
  const card = page.locator('.surface').filter({ hasText: 'Финальная партия' })
  const approve = card.getByRole('button', { name: 'Подтвердить дату' })
  if (await approve.isVisible()) await approve.click()
  await card.getByRole('button', { name: 'Изготовлено' }).click()
  await page.getByLabel('Фактическое количество, шт.').fill('99')
  await page.getByRole('button', { name: 'Отправить на сток' }).click()

  const dialog = page.getByRole('dialog', { name: 'Списать остаток кофе?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Вес, кг')).toHaveValue('0.0121')
  await dialog.getByLabel('Причина').fill('Технологический остаток')
  await dialog.getByRole('button', { name: 'Подтвердить списание' }).click()
  await expect(page.locator('.surface').filter({ hasText: 'Финальная партия' })).toHaveCount(0)

  await page.getByRole('combobox').selectOption('completed')
  const completed = page.locator('.surface').filter({ hasText: 'Финальная партия' })
  await expect(completed).toBeVisible()
  await expect(completed.getByText('Завершено', { exact: true })).toBeVisible()
  await expect(completed.getByRole('button', { name: 'Изготовлено' })).toHaveCount(0)
  expect(errors).toEqual([])
})
