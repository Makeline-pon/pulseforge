/**
 * `version.json` —— 三端共用的版本清单。
 *
 * 一份文件同时服务两个场景：
 *
 *  1. 安装器（NSIS）：安装前读它判断「已装版本 vs 安装包版本」，决定提示升级还是拒绝覆盖；
 *  2. PWA 运行时：页面启动后轮询它，发现服务器版本变新就弹「发现新版本，点击刷新更新」。
 *
 * 放到 `scripts/lib/` 而不是内联进构建脚本，是因为安装器测试、发布测试都要读同一份产物形状，
 * 形状一旦分叉，「安装器认为是最新、页面认为有更新」这种诡异问题就会冒出来。
 *
 * 字段约定（安装器的解析依赖 `"version"` 这个键名与 `"x.y.z"` 的值，改动要两边一起改）：
 *
 * ```json
 * {
 *   "schema": 1,
 *   "name": "PulseForge",
 *   "version": "0.8.0",
 *   "build": "91b15c222a",
 *   "id": "0.8.0+91b15c222a",
 *   "builtAt": "2026-11-10T11:20:00.000Z"
 * }
 * ```
 *
 * `id` 是「版本 + 构建哈希」。同一个版本号重新构建时 `version` 不变、`id` 会变，
 * 运行时因此能发现「版本号没动但代码换了」的重建，而安装器只比较 `version`，不会误报。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 产物文件名。安装器里对应 `PF_VERSION_FILE` 宏。 */
export const VERSION_FILE = 'version.json'

/** 清单结构版本：将来加字段时靠它做兼容分支。 */
export const VERSION_SCHEMA = 1

/**
 * 组装一份清单对象。
 *
 * @param {{ version: string, build: string, name?: string, builtAt?: string }} input
 * @returns {{ schema: number, name: string, version: string, build: string, id: string, builtAt: string }}
 */
export function createVersionDocument(input) {
  const version = input.version
  const build = input.build
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('version.json 需要一个版本号（如 0.8.0）')
  }
  if (typeof build !== 'string' || build.length === 0) {
    throw new Error('version.json 需要一个构建哈希')
  }
  const name = typeof input.name === 'string' && input.name.length > 0 ? input.name : 'PulseForge'
  return {
    schema: VERSION_SCHEMA,
    name: name,
    version: version,
    build: build,
    id: version + '+' + build,
    builtAt: typeof input.builtAt === 'string' ? input.builtAt : new Date().toISOString(),
  }
}

/** 序列化成稳定格式（2 空格缩进 + 结尾换行），方便人肉 diff 与安装器解析。 */
export function stringifyVersionDocument(document) {
  return JSON.stringify(document, null, 2) + '\n'
}

/**
 * 把清单写进某个产物目录（目录不存在会创建）。
 * @returns {string} 写出的文件绝对路径
 */
export function writeVersionJson(dir, document) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, VERSION_FILE)
  writeFileSync(file, stringifyVersionDocument(document), 'utf8')
  return file
}

/**
 * 读回某目录下的清单；不存在或解析失败返回 null。
 * 测试用它核对产物，安装器逻辑则在 NSIS 里用等价的极简解析。
 */
export function readVersionJson(dir) {
  const file = join(dir, VERSION_FILE)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 比较两个「版本号（可带 +构建哈希）」的先后。
 *
 * 只比较点分数字部分；版本号相同时再看构建哈希是否不同：
 *  - 版本号更大 → 1
 *  - 版本号相同、构建哈希不同 → 1（同一版本重建，也算新代码）
 *  - 完全一致 → 0
 *  - 版本号更小 → -1
 */
export function compareVersionIds(nextId, currentId) {
  const nextParts = versionParts(nextId)
  const currentParts = versionParts(currentId)
  for (let index = 0; index < Math.max(nextParts.length, currentParts.length); index += 1) {
    const left = nextParts[index] === undefined ? 0 : nextParts[index]
    const right = currentParts[index] === undefined ? 0 : currentParts[index]
    if (left > right) return 1
    if (left < right) return -1
  }
  return nextId === currentId ? 0 : 1
}

/** 取点分数字段（忽略 `+` 之后的构建哈希与非数字后缀）。 */
function versionParts(text) {
  if (typeof text !== 'string') return [0]
  return text
    .split('+')[0]
    .split('.')
    .map(function (part) {
      const value = parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })
}
