import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { OperationConflict, runOperation } from './operations.mjs'

const digest = value => createHash('sha256').update(value).digest()
const sessionDuration = 8 * 60 * 60 * 1000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function readBody(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 256 * 1024) throw new Error('Запрос слишком большой')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createRepositoryApi({ pool, repository, store, origin, operatorPassword, adminPassword, json }) {
  const sessions = new Map()
  const passwords = { operator: digest(operatorPassword), admin: digest(adminPassword) }
  const secure = new URL(origin).protocol === 'https:' ? '; Secure' : ''
  const commands = {
    createLot: [1],
    updateLot: [2],
    deleteLot: [1, true],
    updateLotDegassing: [3],
    approveSchedule: [1],
    markBU: [1],
    produce: [4],
    writeOffProduction: [3],
    addEmployee: [2, true],
  }

  return async function route(req, res, path) {
    if (!path.startsWith('/api/repository/')) return false
    const reply = (status, body) => { json(res, status, body); return true }
    const token = /(?:^|; *)drip_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1]
    const session = sessions.get(token)
    if (req.method === 'POST' && req.headers.origin !== origin) return reply(403, { error: 'Недопустимый источник запроса' })

    if (path === '/api/repository/login' && req.method === 'POST') {
      const input = JSON.parse(await readBody(req))
      if (!input || !Object.hasOwn(passwords, input.role) || typeof input.password !== 'string' ||
        !timingSafeEqual(passwords[input.role], digest(input.password))) return reply(401, { error: 'Неверные данные входа' })
      for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key)
      if (sessions.size >= 1000) return reply(503, { error: 'Слишком много активных сеансов' })
      if (token) sessions.delete(token)
      const next = randomBytes(32).toString('hex')
      sessions.set(next, { role: input.role, expires: Date.now() + sessionDuration })
      res.setHeader('Set-Cookie', `drip_session=${next}; HttpOnly; SameSite=Strict; Path=/api/repository/; Max-Age=28800${secure}`)
      return reply(200, { role: input.role })
    }

    if (!session || session.expires <= Date.now()) return reply(401, { error: 'Войдите в приложение' })
    if (path === '/api/repository/logout' && req.method === 'POST') {
      sessions.delete(token)
      res.setHeader('Set-Cookie', `drip_session=; HttpOnly; SameSite=Strict; Path=/api/repository/; Max-Age=0${secure}`)
      return reply(204)
    }
    if (path === '/api/repository/snapshot' && req.method === 'GET') {
      const snapshot = await repository.readAppSnapshot()
      const { adminPassword: _password, ...settings } = snapshot.settings
      return reply(200, { ...snapshot, settings })
    }

    const match = /^\/api\/repository\/command\/([A-Za-z]+)$/.exec(path)
    const command = match?.[1]
    if (!command || !Object.hasOwn(commands, command)) return reply(404, { error: 'Команда не найдена' })
    if (req.method !== 'POST') return reply(405, { error: 'Метод не поддерживается' })
    const [arity, adminOnly] = commands[command]
    const isAdmin = session.role === 'admin'
    if (adminOnly && !isAdmin) return reply(403, { error: 'Требуются права администратора' })
    const key = req.headers['idempotency-key']
    if (typeof key !== 'string' || !uuid.test(key)) return reply(400, { error: 'Укажите ключ операции' })
    const body = await readBody(req)
    const args = JSON.parse(body)
    if (!Array.isArray(args) || args.length > arity) return reply(400, { error: 'Некорректные параметры команды' })
    try {
      const result = await runOperation(pool, { actorId: session.role, key, command, body },
        client => store.runWrite(client, () => repository[command](...args), isAdmin))
      return reply(200, result)
    } catch (error) {
      if (error instanceof OperationConflict) return reply(409, { error: error.message })
      if (!error.code && !(error instanceof TypeError)) return reply(422, { error: error.message })
      return reply(422, { error: 'Не удалось выполнить команду' })
    }
  }
}
