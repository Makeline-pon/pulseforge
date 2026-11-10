#!/usr/bin/env node
/**
 * PulseForge 一键发布。
 *
 * 做六件事：改版本号 → 写更新日志 → 跑全部测试 → 提交 → 打标签 → 推送。
 * 任何一步失败都会把已改动的文件恢复原样，避免留下「改了版本但没发布」的半成品。
 *
 * 用法（推荐交互式，直接运行 git_push.bat）：
 *   node scripts/publish.mjs
 *   node scripts/publish.mjs --version 0.8.0 --message "feat: 新增 XX"
 *   node scripts/publish.mjs --dry-run            # 只打印计划与校验，不改文件
 *   node scripts/publish.mjs --yes                # 跳过最后一步确认
 *   node scripts/publish.mjs --no-test            # 跳过测试（不推荐，仅救急）
 *
 * 提交说明的每一行都会变成一条更新日志（面板里那个「更新日志」弹窗），
 * 行首写 `feat:` / `fix:` / `chore:` 决定彩色角标，不写就按原因猜。
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ---------------------------------------------------------------------------
// 纯函数：版本与更新日志的文本处理（tests/publish.test.mjs 直接测这些）
// ---------------------------------------------------------------------------

/** 解析 `1.2.3`；`v1.2.3` 也接受。不合法返回 null。 */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim())
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** 格式化回 `1.2.3`。 */
export function formatVersion(version) {
  return version.major + '.' + version.minor + '.' + version.patch
}

/** 比较两个版本对象：a < b 返回 -1，相等 0，a > b 返回 1。 */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return 0
}

/** 补丁位 +1，用于「建议的下一个版本」。 */
export function nextPatch(version) {
  return { major: version.major, minor: version.minor, patch: version.patch + 1 }
}

/** 本地时区的 `YYYY-MM-DD`，与 CHANGELOG 里既有条目的格式一致。 */
export function todayStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/**
 * 把一行提交说明翻译成更新日志条目。
 *
 * 前缀支持英文与中文两套写法（`feat:` / `新增：`），冒号全角半角都行。
 * 没有前缀时按动词猜 kind，猜不出来就归为杂项，宁可低调也不要谎报「新增功能」。
 */
export function changelogItem(line) {
  const raw = String(line).trim()
  const match = /^(feat|feature|fix|bugfix|chore|docs|refactor|perf)\s*[:：]\s*/i.exec(raw)
  const zhMatch = /^(新增|修复|修正|优化|杂项|文档|重构)\s*[:：]\s*/.exec(raw)

  let text = raw
  let kind = 'chore'

  if (match !== null) {
    text = raw.slice(match[0].length)
    const key = match[1].toLowerCase()
    kind = key === 'feat' || key === 'feature' ? 'feat' : key === 'fix' || key === 'bugfix' ? 'fix' : 'chore'
  } else if (zhMatch !== null) {
    text = raw.slice(zhMatch[0].length)
    const key = zhMatch[1]
    kind = key === '新增' ? 'feat' : key === '修复' || key === '修正' ? 'fix' : 'chore'
  } else if (/^(fix|修复)/i.test(raw)) {
    kind = 'fix'
  } else if (/^(add|新增|支持)/i.test(raw)) {
    kind = 'feat'
  }

  return { kind, text: text.length > 0 ? text : raw }
}

/** TS 单引号字符串转义：反斜杠、单引号和换行都要处理。 */
export function escapeString(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, ' ')
}

/** 生成要插到 CHANGELOG 数组头部的一段源码（含缩进与尾随逗号）。 */
export function renderChangelogEntry(version, date, items) {
  const lines = []
  lines.push('  {')
  lines.push("    version: '" + version + "',")
  lines.push("    date: '" + date + "',")
  lines.push('    items: [')
  for (const item of items) {
    lines.push("      { kind: '" + item.kind + "', text: '" + escapeString(item.text) + "' },")
  }
  lines.push('    ],')
  lines.push('  },')
  return lines.join('\n') + '\n'
}

const CORE_FILE = join('src', 'client', '10-core.ts')
const CHANGELOG_ANCHOR = 'const CHANGELOG: ChangelogEntry[] = [\n'

/**
 * 把版本号与更新日志写进 `10-core.ts` 的源码文本。
 *
 * 用「锚点 + 插入」而不是正则替换整个数组：更新日志里可能有任意中文与引号，
 * 重新序列化容易把用户写过的东西改坏。只替换 PLUGIN_VERSION 那一行、
 * 再往数组开头插一段新条目，其余字节原封不动。
 */
export function applyToCore(source, version, date, items) {
  if (!source.includes(CHANGELOG_ANCHOR)) {
    throw new Error('在 10-core.ts 里找不到 CHANGELOG 声明，无法写入更新日志')
  }
  if (!/const PLUGIN_VERSION = '[^']*'/.test(source)) {
    throw new Error('在 10-core.ts 里找不到 PLUGIN_VERSION，无法写入版本号')
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('更新日志至少要有一条内容')
  }

  const anchorAt = source.indexOf(CHANGELOG_ANCHOR) + CHANGELOG_ANCHOR.length
  const head = source.slice(0, anchorAt) + renderChangelogEntry(version, date, items)
  const tail = source.slice(anchorAt)
  return head.replace(/const PLUGIN_VERSION = '[^']*'/, "const PLUGIN_VERSION = '" + version + "'") + tail
}

/**
 * 解析提交说明：第一行是提交标题，全部非空行都是更新日志条目。
 * 标题若带 `feat:` 前缀，更新日志里也会保留这个语义（由 changelogItem 处理）。
 */
export function splitMessage(message) {
  const lines = String(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) throw new Error('提交说明不能为空')
  return { subject: lines[0], items: lines.map((line) => changelogItem(line)) }
}

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { version: null, message: null, yes: false, dryRun: false, test: true, push: true, remote: 'origin' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--version' || arg === '-v') options.version = argv[++i]
    else if (arg === '--message' || arg === '-m') options.message = argv[++i]
    else if (arg === '--remote') options.remote = argv[++i]
    else if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-test') options.test = false
    else if (arg === '--no-push') options.push = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error('看不懂的参数：' + arg)
  }
  return options
}

const HELP = `
PulseForge 一键发布

  node scripts/publish.mjs [选项]

  --version, -v <x.y.z>   要发布的版本号（不填则交互询问）
  --message, -m <文本>    提交说明，多行用 \\n 分隔（不填则交互询问）
  --remote <name>         远端名，默认 origin
  --yes, -y               跳过最后的确认
  --dry-run               只校验并打印计划，不改文件、不提交
  --no-push               提交并打标签，但不推送
  --no-test               跳过测试（不推荐）
`

function print(line = '') {
  console.log(line)
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options })
}

function git(args, options = {}) {
  return run('git', args, options)
}

/**
 * 读取 git 的一条短输出（分支名、标签列表等）。
 *
 * 为什么不直接拿 execFileSync 的返回值：它靠管道抓 stdout，而某些受限环境（含 DSH 沙箱）
 * 禁止子进程开管道，会直接 EPERM。改成把 stdout 重定向到临时文件再读，
 * 不依赖管道，在任何环境下都能工作。
 */
function gitText(args) {
  const dir = mkdtempSync(join(tmpdir(), 'pulseforge-git-'))
  const file = join(dir, 'stdout.txt')
  const fd = openSync(file, 'w')
  try {
    // stderr 走 ignore：探查仓库时 git 会打印 "fatal: not a git repository"，
    // 而我们自己会给出更友好的提示，没必要让这行噪音吓到用户。
    execFileSync('git', args, { cwd: root, stdio: ['ignore', fd, 'ignore'] })
    return readFileSync(file, 'utf8')
  } finally {
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 交互式提问；标准输入不是终端时直接抛错，避免在 CI 里卡住。 */
async function ask(question, fallback) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(question)).trim()
    return answer.length === 0 ? fallback : answer
  } finally {
    rl.close()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    print(HELP)
    return 0
  }

  // 允许项目放在仓库的子目录里：以 `git rev-parse` 的结果为准，而不是死看 .git 目录
  let toplevel = ''
  try {
    toplevel = gitText(['rev-parse', '--show-toplevel']).trim()
  } catch {
    print('✗ 当前目录不在 git 仓库里：' + root)
    print('')
    print('  第一次发布前先初始化一次（之后就不用再管了）：')
    print('    git init')
    print('    git add -A')
    print('    git commit -m "init: PulseForge"')
    print('    git remote add origin https://github.com/<你的账号>/<仓库名>.git')
    print('    git branch -M main')
    print('    git push -u origin main')
    return 1
  }
  if (toplevel.length === 0) {
    print('✗ 无法确定 git 仓库根目录')
    return 1
  }

  const pkgPath = join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const current = parseVersion(pkg.version)
  if (current === null) {
    print('✗ package.json 里的版本号看不懂：' + pkg.version)
    return 1
  }

  const branch = gitText(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  print('')
  print('PulseForge 发布 · 当前版本 ' + formatVersion(current) + ' · 分支 ' + branch)
  print('─'.repeat(58))
  if (resolve(toplevel) !== resolve(root)) {
    print('  注意：git 仓库根是 ' + toplevel)
    print('        本次提交只包含本项目目录下的改动（git add -A -- .），不会动仓库里其他文件。')
  }

  // 1) 版本号
  let versionText = options.version
  if (versionText === null) {
    if (!process.stdin.isTTY) {
      print('✗ 非交互环境下必须用 --version 指定版本号')
      return 1
    }
    versionText = await ask('新版本号（回车 = ' + formatVersion(nextPatch(current)) + '）：', formatVersion(nextPatch(current)))
  }
  const next = parseVersion(versionText)
  if (next === null) {
    print('✗ 版本号格式应为 x.y.z，收到：' + versionText)
    return 1
  }
  const version = formatVersion(next)
  if (compareVersions(next, current) <= 0) {
    print('✗ 新版本 ' + version + ' 必须大于当前版本 ' + formatVersion(current))
    return 1
  }
  const tag = 'v' + version
  const existingTags = gitText(['tag', '--list', tag]).trim()
  if (existingTags.length > 0) {
    print('✗ 标签 ' + tag + ' 已存在，请换一个版本号或先删除标签')
    return 1
  }

  // 2) 提交说明（同时充当更新日志）
  let message = options.message
  if (message === null) {
    if (!process.stdin.isTTY) {
      print('✗ 非交互环境下必须用 --message 指定提交说明')
      return 1
    }
    print('')
    print('提交说明（第一行是标题；多行请一次贴完，行首可用 feat: / fix: / chore:）')
    message = await ask('> ', '')
    if (message.length === 0) {
      print('✗ 提交说明不能为空')
      return 1
    }
  }
  const { subject, items } = splitMessage(message)
  const date = todayStamp()

  // 3) 计划
  print('')
  print('  版本    ' + formatVersion(current) + '  →  ' + version)
  print('  标签    ' + tag)
  print('  标题    ' + subject)
  print('  日志    ' + items.length + ' 条')
  for (const item of items) print('          [' + item.kind + '] ' + item.text)
  print('  测试    ' + (options.test ? 'npm run test:all' : '跳过（--no-test）'))
  print('  推送    ' + (options.push ? options.remote + '（分支 + 标签）' : '跳过（--no-push）'))
  print('')

  if (options.dryRun) {
    print('（--dry-run：只校验，不改文件）')
    return 0
  }

  // 4) 改文件。先备份，任何失败都原样写回
  const backup = new Map()
  const touched = [
    pkgPath,
    join(root, CORE_FILE),
    join(root, 'src-tauri', 'tauri.conf.json'),
    join(root, 'src-tauri', 'Cargo.toml'),
  ]
  for (const path of touched) {
    if (existsSync(path)) backup.set(path, readFileSync(path, 'utf8'))
  }

  function rollback() {
    for (const [path, content] of backup) {
      try {
        writeFileSync(path, content, 'utf8')
      } catch (error) {
        print('  ⚠ 恢复失败：' + path + '（' + error.message + '）')
      }
    }
    print('  已恢复改动前的文件')
  }

  try {
    const nextPkg = Object.assign({}, pkg, { version })
    writeFileSync(pkgPath, JSON.stringify(nextPkg, null, 2) + '\n', 'utf8')

    const corePath = join(root, CORE_FILE)
    const coreSource = readFileSync(corePath, 'utf8')
    writeFileSync(corePath, applyToCore(coreSource, version, date, items), 'utf8')
    print('  ✓ package.json 与 10-core.ts 已更新')

    // 5) 测试：test:all 内部会重建产物，并把版本同步进 tauri.conf.json、Cargo.toml、sw.js
    if (options.test) {
      print('')
      print('运行测试（会顺带重建产物并同步各处版本号）…')
      const result = spawnSync('npm run test:all', { cwd: root, stdio: 'inherit', shell: true })
      if (result.status !== 0) {
        print('')
        print('✗ 测试失败（exit ' + String(result.status) + '），已中止发布')
        rollback()
        return 1
      }
    } else {
      print('  ⚠ 已跳过测试，版本一致性由你自己保证')
    }

    // 6) 提交 + 标签 + 推送
    print('')
    if (!options.yes && process.stdin.isTTY) {
      const verb = options.push ? '提交并推送' : '提交（不推送）'
      const answer = await ask('确认' + verb + ' ' + tag + '？（回车继续，输入 n 取消）：', 'y')
      if (/^n/i.test(answer)) {
        rollback()
        print('已取消')
        return 1
      }
    }

    // 只提交本项目目录：仓库里可能有与本项目无关的文件（工作区就是这么用的）
    git(['add', '-A', '--', '.'], { stdio: 'inherit' })
    git(['commit', '-m', subject], { stdio: 'inherit' })
    git(['tag', '-a', tag, '-m', 'PulseForge ' + version], { stdio: 'inherit' })

    if (options.push) {
      print('')
      print('推送 ' + branch + ' 与标签 ' + tag + ' 到 ' + options.remote + ' …')
      git(['push', options.remote, 'HEAD', '--follow-tags'], { stdio: 'inherit' })
    } else {
      print('')
      print('（--no-push：已提交并打标签，但没有推送，请手动 git push）')
    }

    print('')
    print('✓ 已发布 ' + tag + (options.push ? '' : '（仅本地）'))
    print('  CI 会在几分钟内产出安装包并创建 Release；进度看仓库的 Actions 页面。')
    return 0
  } catch (error) {
    print('')
    print('✗ 发布失败：' + (error instanceof Error ? error.message : String(error)))
    rollback()
    return 1
  }
}

// 直接运行时才执行；被测试 import 时只拿纯函数
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
