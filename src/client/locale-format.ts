/** Locale-aware usage formatting keyed by DSH's active language. */

const resetFormatters = new Map<string, Intl.DateTimeFormat>()
const numberFormatters = new Map<string, Intl.NumberFormat>()

function resetFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = resetFormatters.get(locale)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
    resetFormatters.set(locale, formatter)
  }
  return formatter
}

function numberFormatter(locale: string): Intl.NumberFormat {
  let formatter = numberFormatters.get(locale)
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
    numberFormatters.set(locale, formatter)
  }
  return formatter
}

/** Format a reset timestamp with DSH's active locale and the browser's time zone. */
export function formatResetTime(timestamp: number | null, locale: string): string | null {
  return timestamp === null ? null : resetFormatter(locale).format(timestamp)
}

/** Format a credit balance with DSH's active locale. */
export function formatUsageNumber(value: number, locale: string): string {
  return numberFormatter(locale).format(value)
}
