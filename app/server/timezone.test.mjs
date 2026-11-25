import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TZ = 'Europe/Moscow'

test('после 21:00 UTC календарный день в Москве уже следующий', () => {
  const boundary = new Date('2026-03-14T21:30:00.000Z')
  assert.equal(boundary.getDate(), 15)
  assert.equal(boundary.getHours(), 0)
  assert.equal(boundary.getMinutes(), 30)
})

test('московское смещение не меняется летом', () => {
  assert.equal(new Date('2026-07-01T12:00:00.000Z').getHours(), 15)
  assert.equal(new Date('2026-01-01T12:00:00.000Z').getHours(), 15)
})
