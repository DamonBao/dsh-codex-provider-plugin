import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

export type TurnElapsedTranslator = ChatNodeViewProps<'assistant-step'>['t']

export function formatRunDuration(ms: number, t: TurnElapsedTranslator): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0
    ? t('duration.minutes', { minutes, seconds: String(seconds).padStart(2, '0') })
    : t('duration.seconds', { seconds })
}

export function formatTurnElapsed(ms: number, t: TurnElapsedTranslator): string {
  const duration = formatRunDuration(ms, t)
  const label = t('message.ranFor', { duration })
  // The requested Codex surface uses “耗时”; preserve every other locale's
  // native conversation translation unchanged.
  return label === `用时 ${duration}` ? `耗时 ${duration}` : label
}

export function formatTurnProcessed(ms: number, t: TurnElapsedTranslator): string {
  const duration = formatRunDuration(ms, t)
  const label = t('message.ranFor', { duration })
  // Keep the native duration grammar and only replace the Chinese state word.
  return label === `用时 ${duration}` ? `已处理 ${duration}` : label
}
