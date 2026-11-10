/**
 * 图标生成库：纯手写 PNG 编码 + SDF 光栅化，以及把多张 PNG 打包成 Windows ICO。
 *
 * 为什么自己写：本机没有任何图像库（sharp/canvas 都没有），也不允许联网装依赖。
 * 图标只是「深色圆角底 + 橙色波形」，用几十行数学 + `zlib.deflateSync` 就能生成，
 * 且与 `src/client/60-icons.ts` 的 WaveIcon 完全一致。
 *
 * 被 `scripts/build-pwa.mjs`（PWA 图标）与 `scripts/build-release.mjs`
 * （Tauri 的 Windows 图标，含 .ico）共用。
 */

import { deflateSync } from 'node:zlib'

/** 与 `60-icons.ts` 的 WaveIcon path 完全一致的折线（16×16 坐标系）。 */
export const WAVE_POINTS = [
  [1.5, 8],
  [2.7, 8],
  [4.3, 3.4],
  [6.5, 12.6],
  [8.7, 6.2],
  [10.6, 10.4],
  [12, 8],
  [13.5, 8],
]

export const BG = [27, 27, 29]
export const FG = [255, 140, 43]

const CRC_TABLE = (function () {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuffer, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 把 RGBA 像素编码为 PNG（8 bit/通道，逐行 filter=0）。 */
export function encodePng(size, rgba) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** 圆角矩形的有符号距离场（负数在内部）。 */
function roundedBoxDistance(px, py, halfWidth, halfHeight, radius) {
  const qx = Math.abs(px) - (halfWidth - radius)
  const qy = Math.abs(py) - (halfHeight - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside - radius
}

/** 点到线段的距离。 */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : clamp01(((px - ax) * dx + (py - ay) * dy) / lengthSquared)
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

function blendPixel(rgba, index, color, alpha) {
  if (alpha <= 0) return
  const currentAlpha = rgba[index + 3] / 255
  const outAlpha = alpha + currentAlpha * (1 - alpha)
  if (outAlpha <= 0) return
  for (let channel = 0; channel < 3; channel += 1) {
    const src = color[channel] * alpha
    const dst = rgba[index + channel] * currentAlpha * (1 - alpha)
    rgba[index + channel] = Math.round((src + dst) / outAlpha)
  }
  rgba[index + 3] = Math.round(outAlpha * 255)
}

/**
 * 生成一张图标 PNG。
 * @param size 边长（px）
 * @param rounded 是否使用圆角透明底（Android maskable 与 Windows 任务栏需要满幅方形）
 * @param scale 波形在图标中的占比（maskable 留出安全区）
 */
export function renderIcon(size, rounded, scale) {
  const rgba = Buffer.alloc(size * size * 4)
  const radius = rounded ? size * 0.22 : 0
  const half = size / 2

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4
      const px = x + 0.5 - half
      const py = y + 0.5 - half
      const coverage = rounded ? clamp01(0.5 - roundedBoxDistance(px, py, half, half, radius)) : 1
      blendPixel(rgba, index, BG, coverage)
    }
  }

  const points = WAVE_POINTS.map(function (point) {
    return [(0.5 + (point[0] / 16 - 0.5) * scale) * size, (0.5 + (point[1] / 16 - 0.5) * scale) * size]
  })
  const strokeRadius = (size / 16) * scale

  for (let segment = 0; segment < points.length - 1; segment += 1) {
    const a = points[segment]
    const b = points[segment + 1]
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0]) - strokeRadius - 2))
    const maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0]) + strokeRadius + 2))
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1]) - strokeRadius - 2))
    const maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1]) + strokeRadius + 2))
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const distance = segmentDistance(x + 0.5, y + 0.5, a[0], a[1], b[0], b[1])
        const coverage = clamp01(strokeRadius + 0.5 - distance)
        blendPixel(rgba, (y * size + x) * 4, FG, coverage)
      }
    }
  }
  return encodePng(size, rgba)
}

/**
 * 把若干张 PNG 打成一个 ICO。
 *
 * 现代 Windows（Vista 以后）支持 ICO 目录项里直接内嵌 PNG 数据，
 * 这样就不需要实现 BMP + AND mask 那套老格式，省掉大量易错代码。
 * @param entries `[{ size, buffer }]`，size 必须是 PNG 的实际边长
 */
export function encodeIco(entries) {
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(count, 4)

  const directory = Buffer.alloc(16 * count)
  let offset = header.length + directory.length
  for (let i = 0; i < count; i += 1) {
    const entry = entries[i]
    const at = i * 16
    // 256 在 ICO 目录里用 0 表示
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory[at + 2] = 0 // 调色板颜色数
    directory[at + 3] = 0 // reserved
    directory.writeUInt16LE(1, at + 4) // color planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.buffer.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.buffer.length
  }

  return Buffer.concat([header, directory].concat(entries.map((entry) => entry.buffer)))
}
