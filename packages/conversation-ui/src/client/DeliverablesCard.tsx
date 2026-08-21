import { useLayoutEffect, useState } from 'react'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconGlobeOutline14,
  IconProjectAddOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeliverableEntry } from './deliverables.ts'
import css from './DeliverablesCard.module.css'

export interface DeliverablesCardProps extends TurnTailOwnerProps {
  readonly matched: readonly DeliverableEntry[]
}

function isWebsite(entry: DeliverableEntry): boolean {
  return entry.kind === 'website' || /^https?:\/\//i.test(entry.path)
}

function openWebsite(path: string): void {
  if (typeof window !== 'undefined') window.open(path, '_blank', 'noopener,noreferrer')
}

function pathParts(path: string): { parent: string; name: string } {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separator < 0) return { parent: '', name: path }
  return { parent: path.slice(0, separator + 1), name: path.slice(separator + 1) }
}

function hiddenKindLabel(entries: readonly DeliverableEntry[]): string {
  if (entries.every(isWebsite)) return '网站'
  if (entries.every(entry => !isWebsite(entry))) return '文件'
  return '产物'
}

function countLabel(entries: readonly DeliverableEntry[]): string {
  const files = entries.filter(entry => !isWebsite(entry)).length
  const websites = entries.length - files
  if (files > 0 && websites === 0) return `已编辑 ${files} 个文件`
  if (files === 0) return `交付 ${websites} 个网站`
  return `已交付 ${entries.length} 项产物`
}

interface EditStats {
  readonly added: number
  readonly removed: number
}

function collectEditStats(turn: number): ReadonlyMap<string, EditStats> {
  const result = new Map<string, EditStats>()
  if (typeof document === 'undefined') return result
  for (const element of document.querySelectorAll<HTMLElement>('[data-stream-edit-stats]')) {
    const row = element.closest<HTMLElement>('[data-stream-turn]')
    if (row?.getAttribute('data-stream-turn') !== String(turn)) continue
    const path = element.getAttribute('data-stream-edit-file')
    const match = /\+(\d+)\s+-\s*(\d+)/.exec(element.textContent ?? '')
    if (path === null || match === null) continue
    result.set(path, { added: Number(match[1]), removed: Number(match[2]) })
  }
  return result
}

/** Codex-style turn-tail card for edited files and deployed websites. */
export function DeliverablesCard({ matched, turn, openFile }: DeliverablesCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [domStats, setDomStats] = useState<ReadonlyMap<string, EditStats>>(() => new Map())
  useLayoutEffect(() => {
    setDomStats(collectEditStats(turn.turn))
  }, [turn.turn, matched])
  const entries = matched.map(entry => {
    const stats = domStats.get(entry.path)
    return stats === undefined || entry.added > 0 || entry.removed > 0 ? entry : { ...entry, ...stats }
  })
  const visible = expanded ? entries : entries.slice(0, 3)
  const hidden = entries.length - visible.length
  const summary = countLabel(entries)
  const hasFiles = entries.some(entry => !isWebsite(entry))
  const firstWebsite = entries.find(isWebsite)
  return (
    <section className={css.root} data-stream-deliverables-card data-stream-deliverables-count={entries.length}>
      <div className={css.header}>
        <span className={css.headerIcon} aria-hidden>
          {hasFiles ? <IconProjectAddOutline16 size={20} /> : <IconGlobeOutline14 size={20} />}
        </span>
        <div className={css.heading}>
          <strong className={css.title}>{summary}</strong>
          {hasFiles ? (
            <button type="button" className={css.subtitle} onClick={() => { setExpanded(true) }}>
              查看更改 ↗
            </button>
          ) : firstWebsite !== undefined ? (
            <button type="button" className={css.subtitle} onClick={() => { openWebsite(firstWebsite.path) }}>
              打开网站 ↗
            </button>
          ) : null}
        </div>
      </div>
      <div className={css.list}>
        {visible.map(entry => {
          const website = isWebsite(entry)
          const parts = pathParts(entry.path)
          return (
            <button
              key={`${entry.kind}:${entry.path}`}
              type="button"
              className={css.item}
              title={entry.path}
              onClick={() => { website ? openWebsite(entry.path) : openFile(entry.path) }}
            >
              {website ? (
                <span className={css.websitePath}>{entry.path}</span>
              ) : (
                <span className={css.filePath}>
                  {parts.parent !== '' && <span className={css.parentPath}>{parts.parent}</span>}
                  <span className={css.fileName}>{parts.name || entry.path}</span>
                </span>
              )}
              {!website && (entry.added > 0 || entry.removed > 0) && (
                <span className={css.stats}>
                  {entry.added > 0 && <span className={css.added}>+{entry.added}</span>}
                  {entry.removed > 0 && <span className={css.removed}>-{entry.removed}</span>}
                </span>
              )}
              {website && <span className={css.external} aria-hidden>↗</span>}
            </button>
          )
        })}
      </div>
      {hidden > 0 && (
        <button type="button" className={css.more} onClick={() => { setExpanded(true) }}>
          再显示 {hidden} 个{hiddenKindLabel(entries.slice(visible.length))}
          <span className={css.moreIcon} aria-hidden><IconChevronDownOutline14 /></span>
        </button>
      )}
      {expanded && entries.length > 3 && (
        <button type="button" className={css.more} onClick={() => { setExpanded(false) }}>
          收起 <span className={css.moreIcon} aria-hidden><IconChevronUpOutline14 /></span>
        </button>
      )}
    </section>
  )
}
