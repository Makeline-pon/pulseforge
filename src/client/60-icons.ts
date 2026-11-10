/**
 * 自绘 16×16 SVG 图标：统一 2px 描边、单色 currentColor，不依赖任何图标库。
 */

interface IconProps {
  size?: number
  className?: string
  'aria-hidden'?: boolean
}

/** 图标外壳：统一 stroke。 */
function svgIcon(children: unknown, props?: IconProps) {
  const size = props !== undefined && props.size !== undefined ? props.size : 16
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: props !== undefined ? props.className : undefined,
      'aria-hidden': 'true',
      focusable: 'false',
    },
    children,
  )
}

/** 侧边栏入口：橙色波形。 */
function WaveIcon(props?: IconProps) {
  return svgIcon(
    [
      h('path', { key: 'w1', d: 'M1.5 8h1.2l1.6-4.6 2.2 9.2 2.2-6.4 1.9 4.2 1.4-2.4h1.5' }),
    ],
    props,
  )
}

/** 播放。 */
function PlayIcon(props?: IconProps) {
  return svgIcon([h('path', { key: 'p', d: 'M4.5 3.2v9.6l8-4.8z', fill: 'currentColor', stroke: 'none' })], props)
}

/** 停止。 */
function StopIcon(props?: IconProps) {
  return svgIcon([h('rect', { key: 's', x: 4, y: 4, width: 8, height: 8, rx: 1.5, fill: 'currentColor', stroke: 'none' })], props)
}

/** 关闭窗口。 */
function CloseIcon(props?: IconProps) {
  return svgIcon([h('path', { key: 'c', d: 'M4 4l8 8M12 4l-8 8' })], props)
}

/** 下载/导出。 */
function DownloadIcon(props?: IconProps) {
  return svgIcon([h('path', { key: 'd', d: 'M8 2v8m0 0l3-3m-3 3L5 7M7 13h2' })], props)
}

/** 删除音符。 */
function TrashIcon(props?: IconProps) {
  return svgIcon([h('path', { key: 't', d: 'M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.6 8h4.8l.6-8' })], props)
}
