// ============================================================
// Split a wacrm contact phone into the phone_country / phone_number
// pair the ZapSign API wants separately.
//
// `contacts.phone` is stored digits-only with DDI (Meta E.164-ish, see
// `sanitizePhoneForMeta` in src/lib/whatsapp/phone-utils.ts), e.g.
// "5511999999999". Every account on wacrm today is Brazilian (BPC/LOAS,
// previdenciário — see docs/), so this stays a fixed "55" split instead
// of a general international parser; broaden it if/when a non-BR
// account shows up.
// ============================================================

export function splitBrazilianPhone(phone: string): {
  country: string
  number: string
} {
  const digits = phone.replace(/\D/g, '')
  if (digits.startsWith('55') && digits.length >= 12) {
    return { country: '55', number: digits.slice(2) }
  }
  return { country: '55', number: digits }
}
