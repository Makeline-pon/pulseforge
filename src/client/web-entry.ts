/**
 * PWA 入口（独立应用）。
 *
 * 与 DSH 插件入口 `99-entry.ts` 的唯一区别：这里没有任何 Cordis 概念 —— 不注册 slot、
 * 不注册命令、不读 `ctx`。整棵界面直接挂到静态页的 `#pf-root` 上，因此同一套
 * `10-core` ~ `95-window` 逻辑可以同时服务「DSH 插件」与「离线 PWA」两种形态。
 *
 * 该文件只在 `scripts/build-pwa.mjs` 里参与打包；`build.mjs`（DSH 插件）不引用它。
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: string }>
}

/**
 * PWA 专属样式（封面页、安装按钮）。
 * 放进这里而不是 `70-controls.ts`：核心分片要保持与宿主无关、且本轮不改动 10~90 分片。
 */
const PWA_STYLE_ID = 'pulseforge-pwa-style'
const PWA_CSS = [
  '.pf-pwa{position:fixed;inset:0;background:#1b1b1d;color:#e8e8ea;',
  'font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
  '.pf-pwa-idle{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;',
  'justify-content:center;gap:18px;background:radial-gradient(circle at 50% 30%,#26262a,#121213 72%)}',
  '.pf-pwa-brand{display:flex;flex-direction:column;align-items:center;gap:8px;color:#ff8c2b}',
  '.pf-pwa-brand h1{margin:0;font-size:26px;letter-spacing:.16em;color:#e8e8ea;font-weight:600}',
  '.pf-pwa-brand p{margin:0;max-width:430px;text-align:center;color:#8a8a92;font-size:12px;line-height:1.7}',
  '.pf-pwa .pf-btn.is-primary{height:34px;padding:0 18px;background:#ff8c2b;border-color:#ff8c2b;color:#1b1204;font-weight:600}',
  '.pf-install{position:fixed;right:16px;bottom:16px;z-index:80;height:32px;padding:0 14px;border-radius:999px;',
  'border:1px solid rgba(255,255,255,.14);background:#232326;color:#ffb066;font-size:12px;cursor:pointer;',
  'box-shadow:0 10px 30px rgba(0,0,0,.45)}',
  '.pf-install:hover{filter:brightness(1.08)}',
  // 新版本提示：右下角胶囊，比安装按钮高一层，避免互相遮挡
  '.pf-update{position:fixed;right:16px;bottom:58px;z-index:81;height:32px;padding:0 14px;border-radius:999px;',
  'border:1px solid rgba(255,140,43,.45);background:#2a2118;color:#ffb066;font-size:12px;cursor:pointer;',
  'display:inline-flex;align-items:center;gap:6px;box-shadow:0 10px 30px rgba(0,0,0,.5);',
  'animation:pf-update-in .18s ease-out}',
  '.pf-update::before{content:"";width:6px;height:6px;border-radius:50%;background:#ff8c2b;',
  'box-shadow:0 0 8px rgba(255,140,43,.9)}',
  '.pf-update:hover{filter:brightness(1.1)}',
  '@keyframes pf-update-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
].join('')

/** 幂等注入 PWA 样式表，返回移除函数。 */
function ensurePwaStyle(): () => void {
  if (document.getElementById(PWA_STYLE_ID) !== null) return function () {}
  const style = document.createElement('style')
  style.id = PWA_STYLE_ID
  style.textContent = PWA_CSS
  document.head.appendChild(style)
  return function () {
    if (style.parentNode !== null) style.parentNode.removeChild(style)
  }
}

let deferredInstall: InstallPromptEvent | null = null
const installListeners = new Set<() => void>()

function notifyInstall(): void {
  for (const listener of Array.from(installListeners)) listener()
}

/** 供 useSyncExternalStore 使用的极简外部 store：是否有可用的安装提示。 */
function subscribeInstall(listener: () => void): () => void {
  installListeners.add(listener)
  return function () {
    installListeners.delete(listener)
  }
}

function getInstallAvailable(): boolean {
  return deferredInstall !== null
}

/** 顶栏右侧的「安装」按钮：只有浏览器真的给出 beforeinstallprompt 时才出现。 */
function PwaInstallButton() {
  const available = React.useSyncExternalStore(subscribeInstall, getInstallAvailable)
  if (!available) return null
  return h(
    'button',
    {
      className: 'pf-install',
      type: 'button',
      'aria-label': '安装 PulseForge 到本机',
      onClick: function () {
        const prompt = deferredInstall
        if (prompt === null) return
        deferredInstall = null
        notifyInstall()
        void prompt.prompt()
      },
    },
    '安装应用',
  )
}

/** PWA 根组件：打开时铺满窗口，关闭后留一个重新打开的入口。 */
function PwaApp() {
  const state = useDaw()
  return h(
    'div',
    { className: 'pf-pwa' },
    state.open
      ? h(PulseForgeOverlay, null)
      : h(
          'div',
          { className: 'pf-pwa-idle' },
          h(PulseForgeBrand, null),
          h(
            'button',
            {
              className: 'pf-btn is-primary',
              type: 'button',
              onClick: openDaw,
              'aria-label': '打开 PulseForge 编辑器',
            },
            '打开编辑器',
          ),
        ),
    h(PwaInstallButton, null),
    h(PwaUpdateBanner, null),
  )
}

/** 离线状态下打开时的封面：避免空白页，也提示当前是纯前端运行。 */
function PulseForgeBrand() {
  return h(
    'div',
    { className: 'pf-pwa-brand' },
    h(WaveIcon, { size: 48 }),
    h('h1', null, 'PulseForge'),
    h('p', null, '浏览器里的 16 轨电子音乐编辑器 · 全部声音由 Web Audio 实时合成'),
  )
}

/*
 * 增量更新状态。
 *
 * 提示有两个来源，界面表现一致：
 *  1. service worker 装好新版本后广播 `pf-update-ready`（静态资源已落地，只等接管）；
 *  2. 页面轮询 `version.json`，发现服务器版本比本地新（`reason: 'server'`）。
 *
 * 状态存成极简外部 store，右下角胶囊按 `reason` 显示不同文案。
 * 只有用户点击时才会刷新，正在编曲时不会被强制打断。
 */
let swRegistration: ServiceWorkerRegistration | null = null
let reloading = false

interface UpdateState {
  ready: boolean
  version: string
  reason: 'worker' | 'server' | ''
}

const UPDATE_IDLE: UpdateState = { ready: false, version: '', reason: '' }
let updateState: UpdateState = UPDATE_IDLE
const updateListeners = new Set<() => void>()

function notifyUpdate(): void {
  for (const listener of Array.from(updateListeners)) listener()
}

function subscribeUpdate(listener: () => void): () => void {
  updateListeners.add(listener)
  return function () {
    updateListeners.delete(listener)
  }
}

function getUpdateState(): UpdateState {
  return updateState
}

/** 标记「有新版本」。同一版本重复通知不会重复渲染。 */
function markUpdateReady(detail?: { version?: string; reason?: 'worker' | 'server' }): void {
  const version = detail !== undefined && typeof detail.version === 'string' ? detail.version : ''
  const reason = detail !== undefined && detail.reason !== undefined ? detail.reason : 'worker'
  if (updateState.ready && updateState.version === version && updateState.reason === reason) return
  updateState = { ready: true, version: version, reason: reason }
  notifyUpdate()
}

/** 本地运行的是哪个构建：`index.html` 里的版本元信息（`版本+哈希`）。 */
function readLocalBuildId(): string {
  if (typeof document === 'undefined') return ''
  const meta = document.querySelector('meta[name="pulseforge-version"]')
  const content = meta === null ? null : meta.getAttribute('content')
  return content === null ? '' : content
}

/** 把 `1.2.3+abcdef` 拆成数字数组，用于比较先后。 */
function versionParts(text: string): number[] {
  return String(text)
    .split('+')[0]
    .split('.')
    .map(function (part) {
      const value = parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })
}

/**
 * 远端是不是比本地新。
 *
 * - 版本号更大 → 新；
 * - 版本号相同但构建哈希不同 → 也算新（同一版本重新构建，代码确实变了）；
 * - 完全一致 → 不算新，避免每次轮询都弹提示。
 */
function isNewerBuild(remoteId: string, localId: string): boolean {
  const remote = versionParts(remoteId)
  const local = versionParts(localId)
  for (let index = 0; index < Math.max(remote.length, local.length); index += 1) {
    const left = remote[index] === undefined ? 0 : remote[index]
    const right = local[index] === undefined ? 0 : local[index]
    if (left > right) return true
    if (left < right) return false
  }
  return remoteId !== localId
}

/**
 * 拉一次 `version.json`，比本地新就弹提示。
 *
 * 返回远端清单（测试与调试用），失败或被跳过时返回 null。
 * 注意 `cache: 'no-store'` + 时间戳查询串：绕过 HTTP 缓存与 service worker 的普通缓存策略。
 */
async function checkVersionFromServer(): Promise<{ version: string; build: string; id: string } | null> {
  if (typeof fetch !== 'function') return null
  try {
    const url = new URL('./version.json', window.location.href)
    url.searchParams.set('t', String(Date.now()))
    const response = await fetch(url.href, { cache: 'no-store' })
    if (!response.ok) return null
    const data = (await response.json()) as { version?: string; build?: string; id?: string }
    if (data === null || typeof data !== 'object' || typeof data.version !== 'string') return null
    const remoteId = typeof data.id === 'string' ? data.id : data.version + '+' + String(data.build)
    const localId = readLocalBuildId()
    // 本地读不到版本（例如直接用 file:// 打开）时不做判断，避免误弹
    if (localId === '') return null
    if (isNewerBuild(remoteId, localId)) {
      markUpdateReady({ version: data.version, reason: 'server' })
    }
    return { version: data.version, build: typeof data.build === 'string' ? data.build : '', id: remoteId }
  } catch (error) {
    // 离线、被墙、静态托管没这个文件：都只是「这次没查成」，不打搅用户
    console.warn('[pulseforge] 版本检查失败，稍后重试', error)
    return null
  }
}

/** 用户点击提示：优先让 waiting 的 SW 接管，否则清缓存后硬刷新。 */
function applyUpdate(): void {
  if (swRegistration !== null && swRegistration.waiting !== null) {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker !== undefined) {
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloading) return
        reloading = true
        window.location.reload()
      })
    }
    swRegistration.waiting.postMessage({ type: 'skip-waiting' })
    return
  }

  // 没有 waiting worker：说明只是静态文件变了（或用户清过缓存）。
  // 让 SW 清掉应用缓存（保留字体），随后刷新，确保拿到的是服务器上的新代码。
  if (typeof navigator !== 'undefined' && navigator.serviceWorker !== undefined && navigator.serviceWorker.controller !== null) {
    navigator.serviceWorker.controller.postMessage({ type: 'purge-caches' })
    window.setTimeout(function () {
      if (reloading) return
      reloading = true
      window.location.reload()
    }, 120)
    return
  }

  reloading = true
  window.location.reload()
}

/** 右下角的「发现新版本 / 新版本已就绪」轻提示。 */
function PwaUpdateBanner() {
  const state = React.useSyncExternalStore(subscribeUpdate, getUpdateState)
  if (!state.ready) return null
  const text =
    state.reason === 'server' && state.version.length > 0
      ? '发现新版本 v' + state.version + '，点击刷新更新'
      : '新版本已就绪，点击刷新更新'
  return h(
    'button',
    {
      className: 'pf-update',
      type: 'button',
      'aria-live': 'polite',
      'aria-label': text,
      onClick: applyUpdate,
    },
    text,
  )
}

/**
 * 注册 service worker，并接管「有新版本」的三种来源：
 *  - SW 主动广播的 `pf-update-ready` 消息；
 *  - 已有的 waiting worker（用户上次没点刷新）；
 *  - `updatefound` 里新 worker 到达 `installed` 状态。
 * 注册失败只打日志，不影响编辑器本身运行。
 */
function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  const scope = new URL('./sw.js', window.location.href).href

  navigator.serviceWorker.addEventListener('message', function (event: MessageEvent) {
    const data = event.data as { type?: string } | null
    if (data !== null && typeof data === 'object' && data.type === 'pf-update-ready') {
      markUpdateReady()
    }
  })

  navigator.serviceWorker
    .register(scope)
    .then(function (registration) {
      swRegistration = registration
      // 上次留下的 waiting worker：直接提示（注意 undefined 也算「没有」）
      if (registration.waiting !== null && registration.waiting !== undefined) markUpdateReady()

      registration.addEventListener('updatefound', function () {
        const installing = registration.installing
        if (installing === null || installing === undefined) return
        installing.addEventListener('statechange', function () {
          // 有 controller 才说明是「更新」，首次安装不算
          if (installing.state === 'installed' && navigator.serviceWorker.controller !== null) {
            markUpdateReady()
          }
        })
      })
    })
    .catch(function (error: unknown) {
      console.warn('[pulseforge] service worker 注册失败，本次仍可在线使用', error)
    })
}

/* -------------------------------------------------------------------------
 * 版本热更新巡检
 *
 * 页面打开后 5 秒查一次，之后每 10 分钟查一次；切回标签页、恢复联网时如果距上次
 * 检查超过 30 秒也会补查一次。查的是构建产物根目录的 `version.json`，只读不写。
 * ---------------------------------------------------------------------- */

const VERSION_PROBE_FIRST_DELAY_MS = 5000
const VERSION_PROBE_INTERVAL_MS = 10 * 60 * 1000
const VERSION_PROBE_THROTTLE_MS = 30 * 1000

let versionWatchStarted = false
let lastVersionProbeAt = 0

/** 带节流的巡检：短时间内重复触发（切标签页、联网）不会连打服务器。 */
function probeVersionIfDue(): void {
  const now = Date.now()
  if (now - lastVersionProbeAt < VERSION_PROBE_THROTTLE_MS) return
  lastVersionProbeAt = now
  void checkVersionFromServer()
}

/** 启动版本巡检。重复调用无副作用（热重载或重复 boot 时安全）。 */
function startVersionWatch(): void {
  if (versionWatchStarted) return
  versionWatchStarted = true
  lastVersionProbeAt = Date.now() - VERSION_PROBE_THROTTLE_MS

  window.setTimeout(probeVersionIfDue, VERSION_PROBE_FIRST_DELAY_MS)
  window.setInterval(probeVersionIfDue, VERSION_PROBE_INTERVAL_MS)

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') probeVersionIfDue()
    })
  }
  window.addEventListener('online', probeVersionIfDue)
}

/** 应用启动：注入样式、打开工程、挂载根组件。 */
function bootPwa(): void {
  const container = document.getElementById('pf-root')
  if (container === null) {
    console.error('[pulseforge] 缺少 #pf-root 容器')
    return
  }

  // 样式由 ensureStyle 幂等注入（已存在则复用）；PWA 封面样式单独注入
  ensureStyle()
  ensurePwaStyle()
  // 打开编辑器会触发 IndexedDB 工程加载
  openDaw()

  window.addEventListener('beforeinstallprompt', function (event: Event) {
    event.preventDefault()
    deferredInstall = event as InstallPromptEvent
    notifyInstall()
  })

  const createRoot = (React as unknown as { createRoot: (node: Element) => { render: (vnode: unknown) => void } })
    .createRoot
  createRoot(container).render(h(PwaApp, null))

  registerServiceWorker()
  startVersionWatch()

  // 调试 / 自动化测试入口：控制台执行 `__pfCheckVersion()` 立即查一次
  ;(window as unknown as { __pfCheckVersion?: () => Promise<unknown> }).__pfCheckVersion = checkVersionFromServer
}

if (typeof document !== 'undefined' && document.getElementById('pf-root') !== null) {
  bootPwa()
}
