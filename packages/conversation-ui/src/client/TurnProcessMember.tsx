import { useEffect, useState, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useTurnProcessFold,
  type TurnFoldAddress,
} from './turnProcessFold.ts'
import css from './TypewriterAssistantNodeView.module.css'

interface TurnProcessMemberProps extends Omit<HTMLAttributes<HTMLDivElement>, 'hidden' | 'id'> {
  readonly address: TurnFoldAddress
  readonly memberId: string
  readonly memberOrder: number
  readonly memberRef?: Ref<HTMLDivElement> | undefined
  readonly turnStartTime?: number | undefined
  readonly formatRunningElapsed?: ((ms: number) => string) | undefined
  readonly children: ReactNode
}

function useElapsedNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

/**
 * One process row in a flat Harness Turn. The earliest registered row owns the
 * Turn disclosure, while this row's own content participates in the shared
 * collapsed state.
 */
export function TurnProcessMember({
  address,
  memberId,
  memberOrder,
  memberRef,
  turnStartTime,
  formatRunningElapsed,
  children,
  ...attributes
}: TurnProcessMemberProps) {
  const fold = useTurnProcessFold(address, { memberId, memberOrder })
  const running = fold.boundary
    && !fold.completed
    && turnStartTime !== undefined
    && formatRunningElapsed !== undefined
  const now = useElapsedNow(running)
  const label = fold.completed
    ? fold.label
    : running ? formatRunningElapsed(now - turnStartTime) : undefined
  return (
    <>
      {fold.boundary && label !== undefined && (
        <div
          className={css.turnFoldRow}
          data-turn-fold-row=""
          data-turn-fold-state={fold.completed ? 'completed' : 'running'}
        >
          {fold.completed ? (
            <button
              type="button"
              className={css.turnFoldButton}
              aria-expanded={!fold.collapsed}
              aria-controls={fold.controls}
              onClick={fold.toggle}
            >
              <span>{label}</span>
              {fold.collapsed ? <IconChevronRightOutline14 /> : <IconChevronDownOutline14 />}
            </button>
          ) : (
            <span className={css.turnFoldLabel} aria-live="off">{label}</span>
          )}
        </div>
      )}
      <div
        {...attributes}
        ref={memberRef}
        id={memberId}
        data-turn-process=""
        hidden={fold.collapsed}
      >
        {children}
      </div>
    </>
  )
}
