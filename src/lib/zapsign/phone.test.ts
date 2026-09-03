import { describe, expect, it } from 'vitest'
import { splitBrazilianPhone } from './phone'

describe('splitBrazilianPhone', () => {
  it('splits a DDI-55 mobile number into country + number', () => {
    expect(splitBrazilianPhone('5511999999999')).toEqual({
      country: '55',
      number: '11999999999',
    })
  })

  it('splits a DDI-55 landline (8-digit local) number', () => {
    expect(splitBrazilianPhone('551133334444')).toEqual({
      country: '55',
      number: '1133334444',
    })
  })

  it('strips non-digit characters before splitting', () => {
    expect(splitBrazilianPhone('+55 (11) 99999-9999')).toEqual({
      country: '55',
      number: '11999999999',
    })
  })

  it('assumes DDI 55 for a number without one (too short to start with 55)', () => {
    expect(splitBrazilianPhone('11999999999')).toEqual({
      country: '55',
      number: '11999999999',
    })
  })
})
