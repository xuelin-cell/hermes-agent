/** Completed durations are whole seconds, never the raw floating-point clock. */
export function responseDurationParts(value: number): { hours: number; minutes: number; seconds: number } {
  const total = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0

  return { hours: Math.floor(total / 3600), minutes: Math.floor(total / 60) % 60, seconds: total % 60 }
}
