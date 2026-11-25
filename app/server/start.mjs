import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStockService, fetchMoySkladStock, validateConfig } from './moysklad.mjs'

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

const index = stock ? html.replace('</head>', '<meta name="drip-girl-moysklad" content="enabled"></head>') : html
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json' }

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body !== undefined ? JSON.stringify(body) : undefined)
}

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
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

const stop = stock?.start((error) => console.error('МойСклад:', error.message))
server.on('close', () => stop?.())
server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1')
