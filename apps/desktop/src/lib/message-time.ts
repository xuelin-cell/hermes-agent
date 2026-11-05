/** Only producer-supplied epoch seconds qualify; never fill missing history with the current clock. */
export function parseMessageTime(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    !Number.isNaN(new Date(value * 1000).getTime())
    ? value
    : undefined
}

/** Full local clock for inspecting the timestamp behind a compact message footer. */
export function formatPreciseMessageTime(seconds: unknown): string {
  const timestamp = parseMessageTime(seconds)

  if (timestamp === undefined) {
    return ''
  }

  const date = new Date(timestamp * 1000)
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`

  return `${day} ${time}.${pad(date.getMilliseconds(), 3)}`
}

/** Uniwork's message footer dates use local calendar days, including across DST transitions. */
export function formatFooterTime(seconds: unknown, locale: string, yesterday: string, now = new Date()): string {
  const timestamp = parseMessageTime(seconds)

  if (timestamp === undefined) {
    return ''
  }

  const date = new Date(timestamp * 1000)
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
  const dayStart = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000)

  if (days === 0) {
    return time
  }

  if (days === 1) {
    return `${yesterday} ${time}`
  }

  const day = date.toLocaleDateString(locale, {
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    month: 'long',
    day: 'numeric'
  })

  return `${day} ${time}`
}
