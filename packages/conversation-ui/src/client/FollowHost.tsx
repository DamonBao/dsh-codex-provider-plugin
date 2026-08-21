import { useRef, type ReactNode } from 'react'
import { useConversationFollow } from './teleprompterGlide.ts'
import css from './TypewriterAssistantNodeView.module.css'

/**
 * Document-flow host that owns conversation-port follow while `active`.
 * Shared by assistant blocks and every other growing Chat row.
 */
export function FollowHost({
  active,
  speedCpsRef,
  minSpeedPxPerSec,
  maxSpeedPxPerSec,
  children,
}: {
  active: boolean
  speedCpsRef: { current: number }
  minSpeedPxPerSec?: number | undefined
  maxSpeedPxPerSec?: number | undefined
  children: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useConversationFollow(rootRef, active, speedCpsRef, minSpeedPxPerSec, maxSpeedPxPerSec)
  return <div ref={rootRef} className={css.follow}>{children}</div>
}
