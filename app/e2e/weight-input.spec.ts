import { test, expect } from '@playwright/test'

test('вес лота и назначения можно стереть и ввести дробное значение', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Администратор' }).click()
  await page.getByLabel('Пароль').fill('1337')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('button', { name: 'Новый лот' }).click()

  const lotWeight = page.getByLabel('Вес после обжарки, кг')
  const allocationWeight = page.getByLabel('Вес 1')
  await expect(page.locator('.allocation-row')).toHaveCount(1)
  await expect(lotWeight).toHaveValue('5')
  await expect(allocationWeight).toHaveValue('5')
  await expect(page.getByText('План выпуска', { exact: true })).toBeVisible()
  await lotWeight.fill('12.5')
  await expect(allocationWeight).toHaveValue('12.5')
  await expect(page.locator('.allocation-output strong')).toHaveText(/1\s*033/)

  const fields = [lotWeight, allocationWeight]
  for (const field of fields) {
    await field.fill('')
    await expect(field).toHaveValue('')
    await field.pressSequentially('0.')
    await expect(field).toHaveValue('0.')
    await field.pressSequentially('25')
    await expect(field).toHaveValue('0.25')
  }
})
