/**
 * 极简 ZIP 写入器（只依赖 node:zlib）。
 *
 * 为什么自己写：发布脚本要在没有第三方依赖的情况下把源码打成 zip，
 * 而 Node 标准库没有 zip 封装（只有 gzip/deflate 流）。这里实现最小子集：
 *   - 每个文件一个「本地文件头 + 数据」；
 *   - 末尾写中央目录与 EOCD；
 *   - 支持 STORE(0) 与 DEFLATE(8) 两种方法，压缩后更大就退回 STORE；
 *   - 文件名按 UTF-8 标记（通用位 11），中文文件名在 Windows 资源管理器里也正常。
 *
 * 不支持：ZIP64（>4GB 或 >65535 个文件）、加密、目录项（目录由文件名前缀隐式建立）。
 */

import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value
  }
  return table
})()

/** 标准 CRC-32（ZIP 用的就是它）。 */
function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/** 把时间转成 MS-DOS 的「日期 + 时间」两个 16 位字段。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff }
}

/**
 * 生成 zip 缓冲区。
 *
 * @param {Array<{ name: string, data: Buffer|string }>} entries 按写入顺序排列的文件
 * @param {{ date?: Date }} [options] 统一的时间戳（默认当前时间）
 * @returns {Buffer}
 */
export function createZip(entries, options = {}) {
  const date = options.date instanceof Date ? options.date : new Date()
  const { dosTime, dosDate } = dosDateTime(date)

  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const crc = crc32(data)

    const deflated = deflateRawSync(data, { level: 9 })
    // 压缩后反而更大（比如很小的 JSON）就按原样存，读起来也不吃亏
    const useDeflate = deflated.length < data.length
    const payload = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6) // 通用位：文件名 UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18) // 压缩后大小
    local.writeUInt32LE(data.length, 22) // 原始大小
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度

    localParts.push(local, nameBuffer, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // 中央目录头签名
    central.writeUInt16LE(0x031e, 4) // 创建版本：3.0 + Unix
    central.writeUInt16LE(20, 6) // 解压所需版本
    central.writeUInt16LE(0x0800, 8) // UTF-8 标记
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30) // 扩展字段
    central.writeUInt16LE(0, 32) // 注释
    central.writeUInt16LE(0, 34) // 磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    // 外部属性：普通文件 rw-r--r--；高位是 Unix 权限，必须 >>> 0 转回无符号
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38)
    central.writeUInt32LE(offset, 42) // 本地头偏移

    centralParts.push(central, nameBuffer)

    offset += local.length + nameBuffer.length + payload.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // EOCD 签名
  end.writeUInt16LE(0, 4) // 当前磁盘
  end.writeUInt16LE(0, 6) // 中央目录起始磁盘
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...localParts, ...centralParts, end])
}
