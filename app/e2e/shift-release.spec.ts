import { test, expect } from '@playwright/test'

for (const width of [1440, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`частичный выпуск из очереди смены на сток, ${width}px, ${theme}`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
      const capture = async (screen: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
        await page.screenshot({
          path: testInfo.outputPath(`${screen}.png`),
          fullPage: true,
          style: '[data-sonner-toaster] { visibility: hidden }',
        })
      }
      await page.setViewportSize({ width, height: 950 })
      await page.goto('/today')
      if (theme === 'dark') {
        await page.getByRole('button', { name: 'Включить тёмную тему' }).click()
        await expect(page.locator('html')).toHaveClass('dark')
      }
      await page.getByRole('button', { name: 'Администратор' }).click()
      await page.getByLabel('Пароль').fill('1337')
      await page.getByRole('button', { name: 'Войти', exact: true }).click()
      await page.getByRole('button', { name: /Предупреждения:/ }).click()
      await page.getByRole('button', { name: 'Заполнить тестовыми данными' }).click()
      await expect(page.getByText('Демонстрационные лоты, сток и состав добавлены')).toBeVisible()

      await page.getByRole('link', { name: 'Сегодня', exact: true }).click()
      await page.getByRole('link', { name: 'Новый лот' }).click()
      const dialog = page.getByRole('dialog', { name: 'Новый лот' })
      const name = 'Санта-Барбара — экспериментальная партия длительной ферментации'
      await dialog.getByLabel('Страна').fill('Гондурас')
      await dialog.getByLabel('Название лота').fill(name)
      await dialog.getByLabel('Дата обжарки').fill('2025-10-06')
      await dialog.getByRole('button', { name: 'Создать лот и задачи' }).click()
      await expect(dialog).toHaveCount(0)
      await page.getByRole('link', { name: 'Сегодня', exact: true }).click()
      const row = page.locator('.shift-row').filter({ hasText: name })
      await expect(row).toContainText('Готово к фасовке')
      await capture('today')
      await row.getByRole('link', { name: 'Внести выпуск' }).click()
      await expect(page.getByRole('heading', { name: 'Готово к работе' })).toBeVisible()
      await page.getByRole('button', { name: 'Внести выпуск' }).click()
      await page.getByLabel('Фактическое количество, шт.').fill('20')
      await page.getByRole('button', { name: 'Отправить на сток' }).click()
      await page.getByRole('button', { name: 'Не списывать' }).click()
      await expect(page.getByRole('status')).toContainText(/На сток поступило 20 шт\..*Остаток кофе/)
      await capture('production')
      await page.getByRole('link', { name: 'Открыть партии на стоке' }).click()
      await expect(page.getByRole('columnheader', { name: 'Доступно' })).toBeAttached()
      const history = page.getByRole('button', { name: `История партии Гондурас / ${name}` })
      await history.focus()
      await page.keyboard.press('Enter')
      const batch = page.getByRole('dialog', { name: `Гондурас / ${name}` })
      await expect(batch.getByText('Приход', { exact: true })).toBeVisible()
      await expect(batch.getByText('+20', { exact: true })).toBeVisible()
      await page.keyboard.press('Shift+Tab')
      await expect(batch.getByRole('button', { name: 'Переназначить' })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(batch.getByRole('button', { name: 'Закрыть' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(batch).toHaveCount(0)
      await expect(history).toBeFocused()
      await capture('inventory')

      await page.setViewportSize({ width: 375, height: 812 })
      await page.getByRole('link', { name: 'Производство', exact: true }).click()
      await expect(page.getByLabel('Показать задачи')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
      await page.getByRole('button', { name: 'Ещё', exact: true }).click()
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Лоты', exact: true })).toBeVisible()
      expect(errors).toEqual([])
    })
  }
}
