// 内部测试沿用发行配置，只替换签名身份和签名后的摘要处理。
const base = require('./electron-builder.config.cjs')
module.exports = {
  ...base,
  mac: {
    ...base.mac,
    sign: {
      ...require('./scripts/mac-sign-policy.cjs'),
      identity: '-',
      gatekeeperAssess: false
    }
  },
  afterSign: 'scripts/after-sign-adhoc.mjs'
}
