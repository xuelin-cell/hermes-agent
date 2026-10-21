export function poolTouchKeys(scope: unknown): string[] {
  const key = String(scope ?? '').trim()

  if (!key) {
    return []
  }

  const localPrefix = 'conn:local::'

  if (key.startsWith(localPrefix)) {
    const delegatedProfile = key.slice(localPrefix.length)

    if (delegatedProfile) {
      return [key, delegatedProfile]
    }
  }

  return [key]
}

/**
 * 通用助手（default 档案）在池子里的键：`default` 或 `conn:local::default`。
 *
 * 它是连接器、邮箱和 UniAI 配置的落点，开连接器、写配置都要它在，所以不占 maxBackends 的名额，也不会
 * 为了腾名额或闲置被收掉；maxBackends 只管专家这类别的档案。它当主后端时根本不进池子，这里管的是
 * 「主后端是别的档案（例如上次在专家里退出），通用助手进了池子」的情况。
 */
export function isPoolAnchor(key: unknown): boolean {
  const [profile] = poolTouchKeys(key).slice(-1)

  return String(profile ?? '').toLowerCase() === 'default'
}
