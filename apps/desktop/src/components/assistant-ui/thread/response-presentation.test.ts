import { expect, it } from 'vitest'

import { responseDurationParts } from './response-presentation'
it('splits finite elapsed times into whole hours, minutes and seconds', () => {
  expect(responseDurationParts(59.98)).toEqual({ hours: 0, minutes: 0, seconds: 59 })
  expect(responseDurationParts(1382.309)).toEqual({ hours: 0, minutes: 23, seconds: 2 })
  expect(responseDurationParts(7382.9)).toEqual({ hours: 2, minutes: 3, seconds: 2 })
  expect(responseDurationParts(Number.NaN)).toEqual({ hours: 0, minutes: 0, seconds: 0 })
  expect(responseDurationParts(-3)).toEqual({ hours: 0, minutes: 0, seconds: 0 })
})
