/**
 * 客户端插件入口：把命令、侧边栏按钮与全窗面板注册进宿主。
 *
 * 槽位名依据（均为运行时探测 + 已安装类型声明双向确认，不是猜测）：
 *  - `sidebar.footer.action`
 *    声明于 `@deepseek-ai/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`
 *    （`SidebarFooterActionOwnerProps { wide: boolean }` 与 `'sidebar.footer.action'` 的
 *    SlotMap 条目），语义为「侧边栏底部、设置按钮旁的操作位」，props 只有 `wide`。
 *  - `shell.overlay`
 *    声明于 `@deepseek-ai/dsh-client-ui-slots` 的 `SlotMap`（list/root 槽），语义为
 *    「跨整帧的点击穿透浮层，每个 id 在既有条目旁新增一层，条目需自行恢复 pointer-events」。
 *  探测方式：对本机所有已安装 `*.d.ts` 做 `interface SlotMap` 键枚举，共得到 81 个槽位名，
 *  其中并不存在任务书假设的 `sidebar.entry`；`main.conversation` 是 single 槽且归
 *  ui-conversation 所有，占用会挤掉聊天面板，故弃用。
 */

/** 侧边栏底部的 16×16 波形入口按钮。 */
function SidebarEntry(props: { wide?: boolean }) {
  return h(
    'button',
    {
      type: 'button',
      className: 'pf-btn pf-icon-btn',
      style: Object.assign({}, THEME_STYLE, {
        width: props.wide === false ? '28px' : '32px',
        height: '32px',
        padding: 0,
        color: 'var(--accent)',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: '6px',
      }),
      'aria-label': '打开 PulseForge 电子音乐编辑器',
      title: 'PulseForge（/pulseforge）',
      onClick: function () {
        openDaw()
      },
      onPointerEnter: function (event: { currentTarget: HTMLElement }) {
        event.currentTarget.style.background = 'rgba(255,140,43,.12)'
        event.currentTarget.style.borderColor = 'var(--line)'
      },
      onPointerLeave: function (event: { currentTarget: HTMLElement }) {
        event.currentTarget.style.background = 'transparent'
        event.currentTarget.style.borderColor = 'transparent'
      },
    },
    h(WaveIcon, { size: 16 }),
  )
}

/** 插件 id，用于全部注册项。 */
const PLUGIN_ID = 'pulseforge'

/**
 * 客户端插件工厂。
 *
 * 返回 `{ inject, apply }`；ModuleLoader 会在 apply 前解析依赖服务。
 * 所有注册都在 ctx.effect 内完成，宿主卸载插件时 disposer 会撤销命令、槽位与音频资源。
 */
function createPulseForge() {
  return {
    inject: ['slots', 'commandUi'],
    apply: function (ctx: any): void {
      try {
        const logger = ctx.logger('pulseforge')
        dawLogger = {
          info: function (message: string, detail?: unknown) {
            logger.info(message, detail)
          },
          warn: function (message: string, detail?: unknown) {
            logger.warn(message, detail)
          },
          error: function (message: string, detail?: unknown) {
            logger.error(message, detail)
          },
        }
      } catch (error) {
        console.warn('[pulseforge] 宿主未提供 logger，退回 console', error)
      }

      // 斜杠命令：/pulseforge 主命令 + /daw 别名；ActionSpec 只有 run(session)
      ctx.effect(function () {
        const offMain = ctx.commandUi.register({
          name: 'pulseforge',
          label: function () {
            return 'PulseForge'
          },
          description: function () {
            return '打开电子音乐编辑器（再次调用仅聚焦已有面板）'
          },
          available: function () {
            return true
          },
          ui: {
            kind: 'action',
            run: function () {
              openDaw()
            },
          },
        })
        const offAlias = ctx.commandUi.register({
          name: 'daw',
          label: function () {
            return 'DAW'
          },
          description: function () {
            return 'PulseForge 的别名命令，行为与 /pulseforge 一致'
          },
          available: function () {
            return true
          },
          ui: {
            kind: 'action',
            run: function () {
              openDaw()
            },
          },
        })
        return function () {
          offMain()
          offAlias()
        }
      })

      // 侧边栏底部入口（依据见文件头注释）
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register({ name: 'sidebar.footer.action', id: PLUGIN_ID, order: 10 }, SidebarEntry)
        })
      })

      // 跨帧浮层：编辑器主界面自己恢复 pointer-events（.pf-window 已设 auto）
      ctx.effect(function () {
        const disposeStyle = ensureStyle()
        const disposeSlot = ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: PLUGIN_ID, order: 10 }, PulseForgeOverlay)
        })
        return function () {
          disposeSlot()
          disposeStyle()
        }
      })

      // 卸载兜底：无论面板是否打开，都释放音频与自动保存定时器
      ctx.effect(function () {
        return function () {
          if (autosaveTimer !== null) {
            clearTimeout(autosaveTimer)
            autosaveTimer = null
          }
          disposeAudioEngine()
        }
      })
    },
  }
}
