// 发布工具的纯逻辑校验：版本解析、更新日志生成、10-core.ts 的改写。
//
// 这些函数会被 git_push.bat 间接调用，改坏了会「发出去的版本号和面板里显示的不一致」，
// 所以这里逐字断言生成出来的源码片段，而不是只断言「包含某个单词」。

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseVersion,
  formatVersion,
  compareVersions,
  nextPatch,
  todayStamp,
  changelogItem,
  escapeString,
  renderChangelogEntry,
  applyToCore,
  splitMessage,
} from '../scripts/publish.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let passed = 0
function check(label, run) {
  try {
    run()
    passed += 1
    console.log('  ✓ ' + label)
  } catch (error) {
    console.error('  ✗ ' + label)
    throw error
  }
}

console.log('publish：检查一键发布工具')

check('版本号解析接受 x.y.z 与 v 前缀', function () {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepEqual(parseVersion('v0.10.20'), { major: 0, minor: 10, patch: 20 })
  assert.deepEqual(parseVersion('  2.0.0  '), { major: 2, minor: 0, patch: 0 })
})

check('版本号解析拒绝不合法输入', function () {
  for (const bad of ['1.2', '1.2.3.4', 'v', '', 'abc', '1.2.x', '1.2.3-beta']) {
    assert.equal(parseVersion(bad), null, bad + ' 不应被接受')
  }
})

check('版本比较与补丁位递增', function () {
  const a = parseVersion('0.7.0')
  const b = parseVersion('0.7.1')
  const c = parseVersion('0.8.0')
  assert.equal(compareVersions(a, b), -1)
  assert.equal(compareVersions(b, a), 1)
  assert.equal(compareVersions(a, parseVersion('0.7.0')), 0)
  assert.equal(compareVersions(c, b), 1)
  assert.equal(formatVersion(nextPatch(a)), '0.7.1')
  assert.equal(formatVersion(parseVersion('1.9.9')), '1.9.9')
})

check('日期戳为本地时区的 YYYY-MM-DD', function () {
  assert.equal(todayStamp(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
  assert.equal(todayStamp(new Date(2026, 11, 31, 0, 1)), '2026-12-31')
})

check('提交说明前缀决定更新日志类型', function () {
  assert.deepEqual(changelogItem('feat: 新增小节复制'), { kind: 'feat', text: '新增小节复制' })
  assert.deepEqual(changelogItem('FIX: 修复导出爆音'), { kind: 'fix', text: '修复导出爆音' })
  assert.deepEqual(changelogItem('chore: 升级依赖'), { kind: 'chore', text: '升级依赖' })
  assert.deepEqual(changelogItem('新增：支持拖拽排序'), { kind: 'feat', text: '支持拖拽排序' })
  assert.deepEqual(changelogItem('修复: 冻结问题'), { kind: 'fix', text: '冻结问题' })
})

check('没有前缀时按动词猜类型，猜不到归为杂项', function () {
  assert.equal(changelogItem('修复了卷帘缩放').kind, 'fix')
  assert.equal(changelogItem('新增音色预设').kind, 'feat')
  assert.equal(changelogItem('随便整理了下注释').kind, 'chore')
})

check('空文本不会产生空条目', function () {
  const item = changelogItem('feat:   ')
  assert.equal(item.kind, 'feat')
  assert.equal(item.text.length > 0, true, '前缀后为空时应保留原始文本')
})

check('源码字符串转义处理引号、反斜杠与换行', function () {
  assert.equal(escapeString("it's ok"), "it\\'s ok")
  assert.equal(escapeString('a\\b'), 'a\\\\b')
  assert.equal(escapeString('第一行\n第二行'), '第一行 第二行')
})

check('生成的更新日志片段缩进与旧条目一致', function () {
  const block = renderChangelogEntry('0.8.0', '2026-11-11', [
    { kind: 'feat', text: '新增 A' },
    { kind: 'fix', text: "修复 it's" },
  ])
  const lines = block.trimEnd().split('\n')
  assert.deepEqual(lines, [
    '  {',
    "    version: '0.8.0',",
    "    date: '2026-11-11',",
    '    items: [',
    "      { kind: 'feat', text: '新增 A' },",
    "      { kind: 'fix', text: '修复 it\\'s' },",
    '    ],',
    '  },',
  ])
})

check('applyToCore 同时写入版本号与新日志，且旧日志不动', function () {
  const source = readFileSync(join(root, 'src', 'client', '10-core.ts'), 'utf8')
  const before = source.match(/version: '(\d+\.\d+\.\d+)'/)[1]
  const result = applyToCore(source, '9.9.9', '2026-11-11', [
    { kind: 'feat', text: '压测条目' },
    { kind: 'fix', text: '压测修复' },
  ])
  assert.match(result, /const PLUGIN_VERSION = '9\.9\.9'/)
  const versions = [...result.matchAll(/version: '(\d+\.\d+\.\d+)'/g)].map((m) => m[1])
  assert.equal(versions[0], '9.9.9', '新条目必须排在数组头部')
  assert.equal(versions[1], before, '旧的最新条目应被推到第二位')
  assert.equal(result.includes('压测条目'), true)
  assert.equal(result.includes("const CHANGELOG: ChangelogEntry[] = ["), true)
  // 数组结构仍然闭合：新条目自带右括号与逗号
  assert.equal(result.includes("      { kind: 'fix', text: '压测修复' },\n    ],\n  },"), true)
})

check('applyToCore 拒绝缺失锚点的源码', function () {
  assert.throws(() => applyToCore('const x = 1\n', '1.0.0', '2026-11-11', [{ kind: 'feat', text: 'a' }]), /CHANGELOG/)
  assert.throws(
    () => applyToCore('const CHANGELOG: ChangelogEntry[] = [\n', '1.0.0', '2026-11-11', [{ kind: 'feat', text: 'a' }]),
    /PLUGIN_VERSION/,
  )
  assert.throws(
    () => applyToCore("const PLUGIN_VERSION = '1.0.0'\nconst CHANGELOG: ChangelogEntry[] = [\n", '1.0.1', '2026-11-11', []),
    /至少/,
  )
})

check('提交说明拆分为标题与多条日志', function () {
  const parsed = splitMessage('feat: 新增打击垫\nfix: 修复导出截断\n\nchore: 清理日志')
  assert.equal(parsed.subject, 'feat: 新增打击垫')
  assert.equal(parsed.items.length, 3)
  assert.deepEqual(parsed.items.map((item) => item.kind), ['feat', 'fix', 'chore'])
  assert.throws(() => splitMessage('   \n  '), /不能为空/)
})

check('git_push.bat 存在并调用发布脚本', function () {
  const bat = join(root, 'git_push.bat')
  assert.ok(existsSync(bat), '缺少 git_push.bat')
  const text = readFileSync(bat, 'utf8')
  assert.ok(text.includes('scripts\\publish.mjs'), 'bat 应把参数转交给 scripts/publish.mjs')
  assert.ok(text.includes('%*'), 'bat 应转发命令行参数，支持非交互用法')
  assert.ok(text.includes('chcp 65001'), 'bat 应切到 UTF-8 代码页，否则中文日志乱码')
  assert.ok(text.includes('exit /b'), 'bat 应把退出码传回调用方，方便 CI 判断')
})

check('npm 脚本与 README 都指向一键发布入口', function () {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['publish:release'], 'node scripts/publish.mjs')
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  assert.ok(readme.includes('git_push.bat'), 'README 应说明一键发布怎么用')
  assert.ok(readme.includes('--dry-run'), 'README 应提到试运行开关')
})

console.log('publish ok：' + passed + ' 组校验通过（版本 / 日志 / 源码改写 / 入口脚本）')
