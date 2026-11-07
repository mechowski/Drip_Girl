import { test, expect } from '@playwright/test'

test('тема переключается без ошибок и сохраняет интерфейс доступным', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('/')
  const dark = page.getByRole('button', { name: 'Включить тёмную тему' })
  await dark.click()
  await expect(page.locator('html')).toHaveClass('dark')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')
  await page.getByRole('button', { name: 'Включить светлую тему' }).click()
  await expect(page.locator('html')).not.toHaveClass('dark')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Администратор' }).click()
  await expect(page.getByRole('dialog', { name: 'Доступ администратора' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('новый дашборд открывается и адаптируется к мобильному экрану', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('/today')
  await expect(page.getByRole('heading', { name: 'Добрый день, Данил' })).toBeVisible()
  await expect(page.locator('.stats-strip > div')).toHaveCount(4)
  await expect(page.getByRole('heading', { name: 'Дегазация на неделе' })).toBeVisible()
  await page.getByRole('link', { name: 'Лоты', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Лоты кофе' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Все', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/today')
  await expect(page.getByRole('heading', { name: 'Добрый день, Данил' })).toBeVisible()
  const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }))
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
  expect(errors).toEqual([])
})
