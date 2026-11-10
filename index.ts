/**
 * PulseForge 宿主半部（Node 侧）。
 *
 * 职责边界（重要）：
 *  - 宿主进程里没有 AudioContext、没有 IndexedDB、也拿不到渲染进程的 DOM，
 *    所以「设置 BPM」这类工具只能做参数归一化与回执，真正改变播放状态的是
 *    渲染进程里的编辑器面板（/pulseforge）。
 *  - 因此本文件不假装能远程驱动编辑器，而是如实返回规范化结果与提示，
 *    让调用方知道应当引导用户到面板里操作。
 */

/** JSON Schema 子集：与宿主 `JsonSchemaNode` 支持的键完全一致（无 minimum/maximum）。 */
interface JsonSchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  title?: string
  description?: string
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: unknown[]
  const?: unknown
  oneOf?: JsonSchemaNode[]
  default?: unknown
  examples?: unknown[]
}

/** 工具返回给模型的文本块。 */
interface ContentBlock {
  type: 'text'
  text: string
}

/** 工具输出定义：schema 描述结构，render 负责模型可见文本。 */
interface ToolOutputDefinition {
  schema: JsonSchemaNode
  render(args: unknown, value: unknown): ContentBlock[]
}

/** 宿主工具定义（完整形态，缺 output 会注册失败）。 */
interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaNode
  output: ToolOutputDefinition
  execute(args: unknown): Promise<unknown>
}

/** 宿主 ToolsService 的最小投影，仅声明本插件用到的方法。 */
interface ToolsHost {
  register(definition: ToolDefinition): () => void
}

/** 宿主 logger 的最小投影。 */
interface LoggerLike {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/**
 * 宿主 Cordis `Context` 的最小结构投影。
 *
 * 这里刻意**不从 `cordis` 包导入类型**：cordis 由 DSH 宿主在运行时提供，
 * npm 上并不存在同名可安装包（DSH 自带的实现叫 `@deepseek-ai/cordis`），
 * 一旦写进 `dependencies`，干净环境执行 `npm install` 就会
 * `No matching version found for cordis@^4.1.0`。
 *
 * 插件只需要 ctx 上这几个成员，结构投影既够用又不引入安装依赖；
 * 宿主传进来的真实 Context 结构兼容，运行时无任何差别。
 */
interface Context {
  /** 命名日志器；老宿主可能没有，调用前用 typeof 判断。 */
  logger?(name: string): LoggerLike
  /** 声明服务依赖并建立子作用域；依赖就绪后才执行回调。 */
  inject(deps: string[], callback: (scoped: Context) => void): unknown
  /** 副作用注册：返回的清理函数在插件卸载时被宿主调用。 */
  effect(fn: () => unknown): unknown
  /** 工具服务；未安装 tools 服务的宿主上为 undefined。 */
  tools?: ToolsHost
}

/** 插件名：与包名、命令名、IndexedDB 库名保持一致。 */
export const name = 'pulseforge'

/** BPM 合法区间，与客户端常量保持一致。 */
const BPM_MIN = 60
const BPM_MAX = 200

/** 工具参数说明（宿主 DSL 不支持 minimum/maximum，范围写进描述并在 execute 校验）。 */
const SET_BPM_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  properties: {
    bpm: {
      type: 'number',
      description: '目标 BPM，取值 60–200；越界会被夹紧到区间端点，小数四舍五入为整数',
    },
  },
  required: ['bpm'],
  additionalProperties: false,
}

/** 工具输出结构。 */
const SET_BPM_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '参数是否被接受（夹紧后仍算接受）' },
    bpm: { type: 'number', description: '归一化后的 BPM 整数' },
    clamped: { type: 'boolean', description: '输入是否越界并被夹紧' },
    note: { type: 'string', description: '人类可读的说明' },
  },
  required: ['ok', 'bpm', 'clamped', 'note'],
  additionalProperties: false,
}

/** 归一化 BPM：非数字判为非法，越界夹紧，小数四舍五入。 */
function normalizeBpm(raw: unknown): { ok: boolean; bpm: number; clamped: boolean; note: string } {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) {
    return { ok: false, bpm: 120, clamped: false, note: 'bpm 必须是数字；已返回默认值 120 供参考' }
  }
  const rounded = Math.round(value)
  const clamped = rounded < BPM_MIN || rounded > BPM_MAX
  const bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, rounded))
  if (clamped) {
    return {
      ok: true,
      bpm: bpm,
      clamped: true,
      note: '输入 ' + rounded + ' 超出 60–200，已夹紧为 ' + bpm + '；请在 /pulseforge 面板中确认实际生效值',
    }
  }
  return {
    ok: true,
    bpm: bpm,
    clamped: false,
    note: 'BPM ' + bpm + ' 合法。宿主进程无法直接修改渲染进程的音频引擎，请在 /pulseforge 面板中设置以生效',
  }
}

/**
 * 插件入口。
 *
 * 服务访问必须显式注入：cordis 在未声明依赖时读取 `ctx.tools` 会抛
 * `cannot get property "tools" without inject`。这里用 `ctx.inject(['tools'], …)`
 * 建立一个等待 tools 就绪的子作用域——工具服务缺失时只跳过本工具注册，
 * 渲染进程里的编辑器面板与命令不受影响。注册全部包在 `ctx.effect` 中，
 * 插件卸载时由宿主调用 disposer 撤销工具。
 */
export function apply(ctx: Context): void {
  let logger: LoggerLike | null = null
  try {
    if (typeof ctx.logger === 'function') logger = ctx.logger('pulseforge')
  } catch (error) {
    console.warn('[pulseforge] 宿主未提供 logger，退回 console', error)
  }

  ctx.inject(['tools'], function (scoped: Context) {
    const tools = scoped.tools
    if (tools === undefined) {
      // 老版本宿主可能没有工具服务；面板与命令由客户端半部独立注册
      if (logger !== null) logger.warn('宿主未提供 tools 服务，跳过 pulseforge_set_bpm 注册')
      return
    }

    scoped.effect(() => {
      const dispose = tools.register({
        name: 'pulseforge_set_bpm',
        description:
          '归一化 PulseForge 的 BPM（60–200，整数）。返回夹紧后的值与说明；实际播放参数需在 /pulseforge 面板中确认。',
        parameters: SET_BPM_PARAMETERS,
        output: {
          schema: SET_BPM_OUTPUT_SCHEMA,
          render: function (args: unknown, value: unknown): ContentBlock[] {
            const result = value as { ok?: boolean; bpm?: number; clamped?: boolean; note?: string }
            const input = args as { bpm?: unknown } | null
            const requested = input !== null && input !== undefined ? String(input.bpm) : '未提供'
            const lines = [
              'pulseforge_set_bpm：请求 ' + requested + ' → 结果 ' + String(result.bpm ?? '未知'),
              String(result.note ?? ''),
            ]
            if (result.clamped === true) lines.push('（输入已越界，被夹紧到合法区间）')
            return [{ type: 'text', text: lines.filter((line) => line.length > 0).join('\n') }]
          },
        },
        execute: async function (args: unknown): Promise<unknown> {
          const input = (args ?? {}) as { bpm?: unknown }
          try {
            const result = normalizeBpm(input.bpm)
            if (logger !== null) {
              logger.info('pulseforge_set_bpm 调用', {
                requested: input.bpm,
                normalized: result.bpm,
                clamped: result.clamped,
              })
            }
            return result
          } catch (error) {
            if (logger !== null) logger.error('pulseforge_set_bpm 执行失败', error)
            return { ok: false, bpm: 120, clamped: false, note: '归一化失败：' + String(error) }
          }
        },
      })
      return () => {
        dispose()
      }
    })
  })
}
