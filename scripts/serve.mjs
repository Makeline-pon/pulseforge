/**
 * PWA 本地预览服务器。
 *
 * 为什么必须用服务器而不是 `file://`：service worker 只能在安全上下文
 * （`https://` 或 `http://localhost`）注册，`file://` 下安装提示与离线缓存都不会工作。
 *
 * 用法：
 *   node scripts/serve.mjs                # http://localhost:5180
 *   node scripts/serve.mjs --port 8080    # 换端口
 *   node scripts/serve.mjs --host 0.0.0.0 # 允许局域网访问（手机测试；需 https 才能装 PWA）
 *
 * 行为：
 *  - 静态文件服务，根目录固定为 `pwa/`；
 *  - `index.html` / `sw.js` / `manifest.json` 返回 `Cache-Control: no-cache`，
 *    否则浏览器会缓存旧版 service worker，导致「改了代码却看不到效果」；
 *  - 其余带内容哈希的静态资源允许短缓存；
 *  - 找不到的路径回退 `index.html`（单页应用语义），但资源类请求返回 404。
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(join(here, '..', 'pwa'))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const NO_CACHE_FILES = new Set(['index.html', 'sw.js', 'manifest.json'])

function parseArgs(argv) {
  // 默认绑 127.0.0.1 而不是 localhost：Windows 上 localhost 常解析成 ::1，
  // 只监听 IPv6 时用 127.0.0.1 访问会「连接被拒绝」。两者都是安全上下文。
  const options = { port: 5180, host: '127.0.0.1' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port' || arg === '-p') {
      const value = Number(argv[index + 1])
      if (Number.isInteger(value) && value > 0 && value < 65536) options.port = value
      index += 1
    } else if (arg === '--host' || arg === '-h') {
      options.host = argv[index + 1] ?? options.host
      index += 1
    }
  }
  return options
}

/** 把 URL 路径安全地映射到根目录下的文件；越界的路径返回 null。 */
function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const target = resolve(rootDir, relative === '' ? 'index.html' : relative)
  if (target !== rootDir && !target.startsWith(rootDir + (process.platform === 'win32' ? '\\' : '/'))) {
    return null
  }
  return target
}

async function readIfFile(target) {
  try {
    const info = await stat(target)
    if (!info.isFile()) return null
    return await readFile(target)
  } catch {
    return null
  }
}

const options = parseArgs(process.argv.slice(2))

const server = createServer(async (request, response) => {
  const urlPath = request.url ?? '/'
  const target = resolvePath(urlPath)

  if (target === null) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('禁止访问该路径')
    return
  }

  let filePath = target
  let body = await readIfFile(filePath)

  // 目录请求：回退到 index.html
  if (body === null && !extname(filePath)) {
    filePath = join(rootDir, 'index.html')
    body = await readIfFile(filePath)
  }

  // 单页应用回退：没有扩展名的路径一律交给 index.html
  if (body === null && !extname(urlPath)) {
    filePath = join(rootDir, 'index.html')
    body = await readIfFile(filePath)
  }

  if (body === null) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('404 未找到：' + urlPath)
    console.warn('404 ' + urlPath)
    return
  }

  const extension = extname(filePath).toLowerCase()
  const fileName = filePath.split(/[\\/]/).pop() ?? ''
  const headers = {
    'Content-Type': MIME[extension] ?? 'application/octet-stream',
    'Cache-Control': NO_CACHE_FILES.has(fileName) ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  }

  response.writeHead(200, headers)
  response.end(body)
})

server.listen(options.port, options.host, () => {
  const suffix = options.port === 80 ? '' : ':' + String(options.port)
  console.log('PulseForge PWA 预览：http://' + options.host + suffix + '/')
  console.log('目录：' + rootDir)
  console.log('')
  console.log('安装测试：')
  console.log('  桌面 Chrome/Edge → 地址栏右侧「安装」图标；或调试面板 → Application → Manifest')
  console.log('  离线测试：DevTools → Application → Service Workers → 勾选 Offline → 刷新')
  console.log('  改完源码先执行 node scripts/build-pwa.mjs，再刷新页面（service worker 会自动换新缓存）')
})
