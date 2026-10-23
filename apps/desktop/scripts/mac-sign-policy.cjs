const fs = require('node:fs')
const path = require('node:path')

const MACHO_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca
])

/** 只识别 Mach-O，避免将只读 Python 字节码当成可签名文件。
 * @param {string} file */
function isMachO(file) {
  const buf = Buffer.alloc(4)
  const fd = fs.openSync(file, 'r')
  try {
    if (fs.readSync(fd, buf, 0, 4, 0) !== 4) {
      return false
    }
  } finally {
    fs.closeSync(fd)
  }
  return MACHO_MAGICS.has(buf.readUInt32BE(0))
}

module.exports = {
  entitlements: path.join(__dirname, '../electron/entitlements.mac.plist'),
  entitlementsInherit: path.join(__dirname, '../electron/entitlements.mac.inherit.plist'),
  hardenedRuntime: true,
  // 目录交由签名器递归，仅排除非原生文件，保持只读缓存不变。
  ignore: (/** @type {string} */ file) => {
    try {
      if (fs.lstatSync(file).isDirectory()) {
        return false
      }
      return !isMachO(file)
    } catch {
      return true
    }
  }
}
