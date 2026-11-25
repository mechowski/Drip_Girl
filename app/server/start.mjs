import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStockService, fetchMoySkladStock, validateConfig } from './moysklad.mjs'
import { createPool } from './db.mjs'
import { createRepositoryApi } from './repository-api.mjs'
import { expectedSchemaVersion, listMigrations, schemaStatus } from './schema.mjs'

const root = fileURLToPath(new URL('../dist', import.meta.url))
const html = await readFile(resolve(root, 'index.html'), 'utf8')
const token = process.env.MOYSKLAD_TOKEN
const configPath = process.env.MOYSKLAD_CONFIG
const stock = token && configPath ? await createStockService({
  readStock: (() => {
    let config
    return async () => {
      config ??= validateConfig(JSON.parse(await readFile(configPath, 'utf8')))
      return fetchMoySkladStock(config, token)
    }
  })(),
  cachePath: process.env.MOYSKLAD_CACHE ?? 'moysklad.cache.local',
}) : undefined

const baseIndex = stock ? html.replace('</head>', '<meta name="drip-girl-moysklad" content="enabled"></head>') : html
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json' }

const expectedSchema = expectedSchemaVersion(await listMigrations())
const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : undefined

async function health() {
  if (!pool) return { code: 200, body: { status: 'ok', database: 'disabled' } }
  try {
    const { rows } = await pool.query('SELECT max(version) AS version FROM schema_migrations')
    const status = schemaStatus(rows[0]?.version ?? 0, expectedSchema)
    if (!status.ready) return { code: 503, body: { status: 'error', database: 'up', ...status } }
    return { code: 200, body: { status: 'ok', database: 'up', ...status } }
  } catch (error) {
    console.error('Проверка базы данных:', error.message)
    return { code: 503, body: { status: 'error', database: 'down' } }
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body !== undefined ? JSON.stringify(body) : undefined)
}

const operatorPassword = process.env.DRIP_OPERATOR_PASSWORD
const adminPassword = process.env.DRIP_ADMIN_PASSWORD
let repositoryApi
let stopServerIntegrations
const serverStorage = process.env.DRIP_STORAGE_MODE === 'server' || Boolean(operatorPassword || adminPassword)
if (serverStorage) {
  if (!pool || !operatorPassword || !adminPassword || operatorPassword === adminPassword) {
    throw new Error('Для серверного хранения нужны DATABASE_URL и два разных пароля входа')
  }
  const repository = await import('../server-dist/repository.mjs')
  const store = repository.configureStore(pool)
  const refreshMoySklad = async (force = true) => {
    if (!stock) throw new Error('Серверное подключение МоегоСклада не настроено')
    const snapshot = force ? await stock.refresh() : stock.latest()
    if (snapshot) await repository.applyMoySkladSnapshot(snapshot)
  }
  let refreshing = false
  const refreshSheets = async () => {
    if (refreshing) return
    refreshing = true
    try {
      const connections = await store.transaction('r', () => store.sheetConnections.toArray())
      const connection = repository.currentSheetConnection(connections)
      if (connection && repository.isSheetRefreshDue(connection)) await repository.refreshPublicSheets(connection, connection)
    } finally { refreshing = false }
  }
  const report = error => console.error('Интеграции:', error.message)
  const sync = () => { void refreshSheets().catch(report) }
  const sheetTimer = setInterval(sync, 60_000).unref()
  const updateStock = () => { void refreshMoySklad().catch(report) }
  const stockTimer = stock ? setInterval(updateStock, 3_600_000).unref() : undefined
  sync()
  if (stock) updateStock()
  stopServerIntegrations = () => { clearInterval(sheetTimer); clearInterval(stockTimer) }
  repositoryApi = createRepositoryApi({
    pool, repository, store, json, operatorPassword, adminPassword, refreshMoySklad,
    origin: process.env.APP_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`,
  })
}

const index = repositoryApi
  ? baseIndex.replace('</head>', '<meta name="drip-girl-storage" content="server"></head>')
  : baseIndex

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
    if (pathname.startsWith('/api/repository/')) {
      if (repositoryApi) return await repositoryApi(req, res, pathname)
      return json(res, 503, { error: 'Серверное хранилище не настроено' })
    }
    if (pathname === '/api/health') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Метод не поддерживается' })
      const { code, body } = await health()
      return json(res, code, body)
    }
    if (pathname === '/api/moysklad/stock') {
      if (req.method === 'GET') {
        const snapshot = stock?.latest()
        return snapshot ? json(res, 200, snapshot) : json(res, 204)
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Метод не поддерживается' })
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) {
        return json(res, 403, { error: 'Обновите сток из приложения' })
      }
      if (!stock) return json(res, 503, { error: 'Серверное подключение МоегоСклада не настроено' })
      try { return json(res, 200, await stock.refresh()) } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : 'Не удалось обновить остатки' })
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405)
    const path = resolve(root, `.${pathname}`)
    if (path !== root && !path.startsWith(root + sep)) return json(res, 404)
    if (extname(pathname)) {
      const body = await readFile(path).catch(() => undefined)
      if (!body) return json(res, 404)
      res.writeHead(200, { 'Content-Type': mime[extname(pathname)] ?? 'application/octet-stream' })
      return res.end(req.method === 'HEAD' ? undefined : body)
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(req.method === 'HEAD' ? undefined : index)
  } catch {
    json(res, 400, { error: 'Некорректный запрос' })
  }
})

const stop = !repositoryApi && stock?.start((error) => console.error('МойСклад:', error.message))
server.on('close', () => { if (stop) stop(); stopServerIntegrations?.(); void pool?.end() })
server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1')
