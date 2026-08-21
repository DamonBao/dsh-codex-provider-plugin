import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { ConversationEventRegistry, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, memo, useState, type FunctionComponent } from 'react'
import { readFileSync } from 'node:fs'
import { TypewriterAssistantNodeView } from '../src/client/TypewriterAssistantNodeView.tsx'
import { FollowHost } from '../src/client/FollowHost.tsx'
import {
  computeFollowStep,
  FOLLOW_LERP_DT_MS,
  FOLLOW_LERP_MAX,
  FOLLOW_SPEED_REF_CPS,
} from '../src/client/teleprompterGlide.ts'
import {
  BACKLOG_CHAR_CEILING,
  BACKLOG_SECOND_CEILING,
  PRESET_CONFIG,
  splitGraphemes,
  computeQueueReveal,
  computeSettleDrain,
  useConversationContent,
} from '../src/client/useConversationContent.ts'
import { apply, inject } from '../src/client/index.ts'
import {
  editDiffStats,
  isGrowingChatNode,
  nativeActivityGroup,
  nestedToolIconTargets,
  semanticToolKind,
  toolActivityGroup,
  wrapFollowNodeView,
} from '../src/client/TypewriterToolNodeView.tsx'
import { wrapTurnPreludeNodeView } from '../src/client/TurnPreludeUserNodeView.tsx'
import { DeliverablesCard } from '../src/client/DeliverablesCard.tsx'
import { DELIVERABLES_DATA_KEY, deliverablesDefinition, selectDeliverables } from '../src/client/deliverables.ts'
import { DEFAULT_CONVERSATION_CONFIG, CONVERSATION_BOOT_GLOBAL } from '../src/config.ts'
import { Config } from '../src/plugin.ts'
import css from '../src/client/TypewriterAssistantNodeView.module.css'

const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] as const
const FOLLOW_SPEED = { current: 35 }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function assistantProps(
  status: 'running' | 'settled',
  blocks: unknown[],
  {
    closing = false,
    completed = false,
    nodeKey = 'assistant-1',
    sessionId = 'session-1',
    turnNumber = 1,
  }: {
    closing?: boolean
    completed?: boolean
    nodeKey?: string
    sessionId?: string
    turnNumber?: number
  } = {},
): Parameters<typeof TypewriterAssistantNodeView>[0] {
  const finalNode = status === 'settled'
    ? { kind: 'assistant', seq: 42, messageId: nodeKey, time: 1, turn: turnNumber, step: 1, blocks }
    : undefined
  const turn = {
    turn: turnNumber,
    status: completed ? 'closed' : 'open',
    start: { time: 1_000 },
    end: completed ? { time: 1_112_000, data: { reason: { kind: 'completed' } } } : undefined,
  }
  return {
    node: {
      key: nodeKey,
      kind: 'assistant-step',
      location: { kind: 'step', turn, step: { step: 1 } },
      data: { status, blocks, turn: turnNumber, step: 1, time: 0, finalNode },
    },
    sessionId,
    useTurnData: () => closing && finalNode !== undefined ? { closing: { finalNode } } : undefined,
    openFile: () => {},
    fileMentions: () => undefined,
    t: (key: string, parameters?: Record<string, unknown>) => {
      if (key === 'duration.minutes') return `${parameters?.minutes}分${parameters?.seconds}秒`
      if (key === 'duration.seconds') return `${parameters?.seconds}秒`
      if (key === 'message.ranFor') return `用时 ${parameters?.duration}`
      return key
    },
  } as unknown as Parameters<typeof TypewriterAssistantNodeView>[0]
}

function SmoothProbe({ text, shouldHoldBack, steadyCps }: { text: string; shouldHoldBack?: () => boolean; steadyCps?: number }) {
  const displayed = useConversationContent(text, { shouldHoldBack, steadyCps })
  return <span>{displayed}</span>
}

describe('useConversationContent', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE] }))

  it('reveals an appended stream progressively instead of dumping it', async () => {
    const view = render(<SmoothProbe text="" />)
    view.rerender(<SmoothProbe text={'x'.repeat(40)} />)

    expect(view.container.textContent).toBe('')
    await act(() => vi.advanceTimersByTimeAsync(120))
    const partial = view.container.textContent?.length ?? 0
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(40)

    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(view.container.textContent).toBe('x'.repeat(40))
  })

  it('reveals at the steady rate while input streams and drains at 1.8x after', async () => {
    const view = render(<SmoothProbe text="" steadyCps={25} />)
    view.rerender(<SmoothProbe text={'x'.repeat(100)} steadyCps={25} />)
    // ~48ms minimum commit interval: a few commits land, far below the input.
    await act(() => vi.advanceTimersByTimeAsync(200))
    const partial = view.container.textContent?.length ?? 0
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(40)
    // After the (fake) stream goes idle and settling kicks in, the 1.8x
    // drain clears the remaining backlog quickly but not instantly.
    await act(() => vi.advanceTimersByTimeAsync(2500))
    expect(view.container.textContent).toBe('x'.repeat(100))
  })

  it('keeps up with a fast chunked arrival instead of trailing at the old 72cps cap', async () => {
    const view = render(<SmoothProbe text="" />)
    view.rerender(<SmoothProbe text={'x'.repeat(20)} />)
    await act(() => vi.advanceTimersByTimeAsync(40))
    view.rerender(<SmoothProbe text={'x'.repeat(40)} />)
    await act(() => vi.advanceTimersByTimeAsync(40))
    view.rerender(<SmoothProbe text={'x'.repeat(60)} />)
    await act(() => vi.advanceTimersByTimeAsync(40))
    view.rerender(<SmoothProbe text={'x'.repeat(80)} />)
    await act(() => vi.advanceTimersByTimeAsync(80))
    const partial = view.container.textContent?.length ?? 0
    // 80 chars over ~200ms is 400 cps arrival. The old maxCps=72 cap would
    // have revealed ~15 chars; keep-up must be well past that.
    expect(partial).toBeGreaterThan(40)
    expect(partial).toBeLessThanOrEqual(80)
  })

  it('queues a large append instead of dumping it', async () => {
    const view = render(<SmoothProbe text="" />)
    view.rerender(<SmoothProbe text={'x'.repeat(240)} />)
    await act(() => vi.advanceTimersByTimeAsync(120))
    const partial = view.container.textContent?.length ?? 0
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(240)
    await act(() => vi.advanceTimersByTimeAsync(8000))
    expect(view.container.textContent).toBe('x'.repeat(240))
  })

  it('holds back the DOM commit while the guard vetoes and flushes after', async () => {
    let hold = true
    const view = render(<SmoothProbe text="" shouldHoldBack={() => hold} />)
    view.rerender(<SmoothProbe text="hello world" shouldHoldBack={() => hold} />)

    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(view.container.textContent).toBe('')

    hold = false
    view.rerender(<SmoothProbe text="hello world" shouldHoldBack={() => hold} />)
    await act(() => vi.advanceTimersByTimeAsync(1200))
    expect(view.container.textContent).toBe('hello world')
  })

  it('reveals whole grapheme clusters instead of splitting an emoji sequence', () => {
    expect(splitGraphemes('A👩‍💻B')).toEqual(['A', '👩‍💻', 'B'])
  })
})

describe('assistant renderer', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE] }))

  it('does not render a caret while streaming', () => {
    const block = { kind: 'text', text: 'hello' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    expect(view.container.textContent).not.toContain('▍')
  })

  it('renders teleprompter mode from the latest model snapshot without an artificial reveal queue', () => {
    const view = render(<TypewriterAssistantNodeView
      {...assistantProps('running', [{ kind: 'text', text: 'start' }])}
      mode="teleprompter"
    />)
    const text = 'start plus the rest of the Codex-style progress update'
    view.rerender(<TypewriterAssistantNodeView
      {...assistantProps('running', [{ kind: 'text', text }])}
      mode="teleprompter"
    />)
    expect(view.container.textContent).toContain(text)
  })

  it('marks streaming, process, and final Assistant rows for Codex timeline styling', () => {
    const running = render(<TypewriterAssistantNodeView {...assistantProps('running', [
      { kind: 'text', text: 'checking the source' },
    ])} />)
    expect(running.container.querySelector('[data-stream-phase="streaming"]')).not.toBeNull()

    const process = render(<TypewriterAssistantNodeView {...assistantProps('settled', [
      { kind: 'text', text: 'found one cause' },
    ])} />)
    expect(process.container.querySelector('[data-stream-phase="process"]')).not.toBeNull()

    const final = render(<TypewriterAssistantNodeView {...assistantProps('settled', [
      { kind: 'text', text: 'the fix is ready' },
    ], { closing: true })} />)
    expect(final.container.querySelector('[data-stream-phase="final"]')).not.toBeNull()
  })

  it('shows a live processed-duration rule before the first process stream and turns it into the final fold', async () => {
    vi.setSystemTime(new Date(77_000))
    const runningProps = assistantProps('running', [
      { kind: 'text', text: 'checking the source' },
    ], { nodeKey: 'live-process' })
    const view = render(<TypewriterAssistantNodeView {...runningProps} mode="teleprompter" />)

    const runningRow = view.container.querySelector('[data-turn-fold-state="running"]') as HTMLElement | null
    const runningProcess = view.container.querySelector('[data-stream-phase="streaming"]') as HTMLElement
    expect(runningRow?.textContent).toContain('已处理 1分16秒')
    expect(runningRow?.querySelector('button')).toBeNull()
    expect(runningProcess.hidden).toBe(false)
    expect((runningRow as Node).compareDocumentPosition(runningProcess) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    expect(styleSheet).toMatch(/\.turnFoldRow\s*{[^}]*flex-direction:\s*column/s)
    expect(styleSheet).toMatch(/\.turnFoldRow::after\s*{[^}]*width:\s*100%[^}]*flex:\s*none/s)
    expect(styleSheet).toMatch(/\.turnFoldButton,\s*\n\.turnFoldLabel\s*{[^}]*align-self:\s*flex-start/s)

    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(runningRow?.textContent).toContain('已处理 1分17秒')

    view.rerender(<>
      <TypewriterAssistantNodeView {...assistantProps('settled', [
        { kind: 'text', text: 'checking the source' },
      ], { completed: true, nodeKey: 'live-process' })} />
      <TypewriterAssistantNodeView {...assistantProps('settled', [
        { kind: 'text', text: 'the final answer' },
      ], { closing: true, completed: true, nodeKey: 'live-final' })} />
    </>)

    const completedToggle = view.getByRole('button', { name: /耗时 18分31秒/ })
    const completedProcess = view.getByText('checking the source').closest('[data-turn-process]') as HTMLElement
    expect(completedProcess.hidden).toBe(true)
    expect(completedToggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('the final answer').closest('[data-stream-node]')?.hasAttribute('hidden')).toBe(false)
  })

  it('puts the Turn disclosure before process rows and folds final-node reasoning', () => {
    const view = render(<>
      <TypewriterAssistantNodeView {...assistantProps('settled', [
        { kind: 'text', text: 'checking the source' },
      ], { completed: true, nodeKey: 'process-1' })} />
      <TypewriterAssistantNodeView {...assistantProps('settled', [
        { kind: 'reasoning', text: 'last private verification' },
        { kind: 'text', text: 'the final answer' },
      ], { closing: true, completed: true, nodeKey: 'final-1' })} />
    </>)

    const process = view.container.querySelector('[data-stream-phase="process"]') as HTMLElement
    const final = view.container.querySelector('[data-stream-phase="final"]') as HTMLElement
    const toggle = view.getByRole('button', { name: /耗时 18分31秒/ })
    expect(process.hidden).toBe(true)
    expect(final.hidden).toBe(false)
    const reasoning = view.getAllByText('last private verification')[0] as HTMLElement
    const finalReasoningProcess = reasoning.closest('[data-turn-process]') as HTMLElement | null
    expect(finalReasoningProcess).not.toBeNull()
    expect(finalReasoningProcess?.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toContain(process.id)
    expect(toggle.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    expect(styleSheet).toMatch(/\[data-turn-process\]\[hidden\]\s*{[^}]*display:\s*none\s*!important/s)
    expect(styleSheet).toMatch(
      /data-chat-anchor-key[^}]*:has\(\[data-turn-process\]\[hidden\]\)[^}]*:not\(:has\(\[data-turn-fold-row\]\)\)[^}]*:not\(:has\(\[data-stream-phase='final'\]\)\)[^{]*{[^}]*display:\s*none\s*!important/s,
    )

    fireEvent.click(toggle)
    expect(process.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(finalReasoningProcess?.hidden).toBe(false)
    expect(view.getAllByText('last private verification').length).toBeGreaterThan(0)
    expect(view.getByText('the final answer').closest('[data-stream-node]')?.hasAttribute('hidden')).toBe(false)
  })

  it('assigns session-level context to the following Turn and makes it the disclosure boundary', () => {
    function ContextFixture() {
      return <span>workspace context</span>
    }
    const WrappedContext = wrapFollowNodeView(ContextFixture)
    const finalProps = assistantProps('settled', [
      { kind: 'text', text: 'context final answer' },
    ], { closing: true, completed: true, nodeKey: 'context-final', sessionId: 'context-session' })
    const contextNode = {
      key: 'context-1',
      kind: 'context',
      anchorSeq: 10,
      location: { kind: 'session' },
      data: { seq: 10 },
    }
    const finalNode = finalProps.node
    const snapshot = {
      chat: {
        order: [contextNode.key, finalNode.key],
        nodes: {
          get: (key: string) => key === contextNode.key ? contextNode : finalNode,
        },
      },
    }
    const useSession = (selector: (value: typeof snapshot) => unknown) => selector(snapshot)
    const view = render(<>
      <WrappedContext
        sessionId="context-session"
        useSession={useSession}
        node={contextNode}
      />
      <TypewriterAssistantNodeView {...finalProps} />
    </>)

    const toggle = view.getByRole('button', { name: /耗时/ })
    const context = view.getByText('workspace context').closest('[data-stream-node]') as HTMLElement
    expect(context.hidden).toBe(true)
    expect(toggle.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(toggle.getAttribute('aria-controls')).toContain(context.id)
  })

  it('keeps completed failures visible instead of hiding their diagnostic process', () => {
    const props = assistantProps('settled', [
      { kind: 'text', text: 'failure details' },
    ], { closing: true, completed: true, nodeKey: 'failed-final' })
    const failedTurn = {
      ...(props.node.location as unknown as { turn: Record<string, unknown> }).turn,
      end: { time: 6_000, data: { reason: { kind: 'error' } } },
    }
    const view = render(<TypewriterAssistantNodeView
      {...props}
      node={{ ...props.node, location: { kind: 'step', turn: failedTurn, step: { step: 1 } } } as typeof props.node}
    />)

    expect(view.container.querySelector('[data-stream-phase="final"]')).not.toBeNull()
    expect(view.queryByRole('button', { name: /耗时/ })).toBeNull()
    expect(view.getByText('failure details').closest('[data-stream-node]')?.hasAttribute('hidden')).toBe(false)
  })

  it('isolates expanded state by session and Turn', () => {
    const renderTurn = (turnNumber: number, sessionId = 'session-1') => <>
      <TypewriterAssistantNodeView {...assistantProps('settled', [
        { kind: 'text', text: `process ${sessionId}-${turnNumber}` },
      ], { completed: true, nodeKey: `process-${turnNumber}`, sessionId, turnNumber })} />
      <TypewriterAssistantNodeView {...assistantProps('settled', [
        { kind: 'text', text: `final ${sessionId}-${turnNumber}` },
      ], { closing: true, completed: true, nodeKey: `final-${turnNumber}`, sessionId, turnNumber })} />
    </>
    const view = render(<>{renderTurn(1)}{renderTurn(2)}</>)
    const toggles = view.getAllByRole('button', { name: /耗时/ })

    fireEvent.click(toggles[0] as HTMLElement)
    expect(view.getByText('process session-1-1').closest('[data-stream-node]')?.hasAttribute('hidden')).toBe(false)
    expect(view.getByText('process session-1-2').closest('[data-stream-node]')?.hasAttribute('hidden')).toBe(true)
  })

  it('renders streaming text through Markdown without a raw-text tail', () => {
    const block = { kind: 'text', text: '**finished**' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    // The emphasis renders during streaming: no plain `**finished**` fallback.
    expect(view.getByText('finished').tagName).toBe('STRONG')
  })

  it('separates a paragraph that follows a top-level Markdown list', () => {
    const text = [
      '修改的文件：',
      '',
      '- `/tmp/07-troubleshooting-playbook.md`',
      '- `/tmp/08-agent-index.md`',
      '- `/tmp/09-diagnostic-query-templates.md`',
      '',
      '补充说明：该 wiki 目录是纯 Markdown 知识库。',
    ].join('\n')
    const view = render(<TypewriterAssistantNodeView {...assistantProps('settled', [
      { kind: 'text', text },
    ], { closing: true })} />)
    const paragraph = view.getByText(/补充说明/)
    expect(paragraph.previousElementSibling?.tagName).toBe('UL')
    expect(paragraph.parentElement?.parentElement?.className).toBe(css.markdownFlow)
    // Vitest does not apply imported CSS Modules in jsdom, so pin the visual
    // contract in the stylesheet and leave computed-style verification to the
    // browser QA pass.
    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    expect(styleSheet).toMatch(
      /\.markdownFlow > div > :where\(ul, ol\) \+ p\s*{[^}]*margin-block-start:\s*24px/s,
    )
  })

  it('does not trim list-item line boxes around wrapped inline code', () => {
    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    const trimRule = styleSheet.match(/@supports \(text-box-trim: trim-both\) \{([\s\S]*?)\n\}/)?.[1]
    expect(trimRule).toBeDefined()
    const trimmedElements = trimRule?.match(/\.root :is\(([^)]*)\)/)?.[1]
    expect(trimmedElements).toBeDefined()
    expect(trimmedElements).not.toMatch(/\bli\b/)
    expect(trimRule).toMatch(/:not\(:has\(code\)\)/)
  })

  it('swaps to the settled full parse exactly once after the queue drains', async () => {
    const block = { kind: 'text', text: '**finished**' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    view.rerender(<TypewriterAssistantNodeView {...assistantProps('settled', [block])} />)
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(view.getByText('finished').tagName).toBe('STRONG')
  })

  it('renders Think as ordinary Turn prose instead of a separate disclosure', () => {
    const block = { kind: 'reasoning', text: 'first line\nlatest tokens' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [block])} />)
    const reasoning = view.container.querySelector('[data-stream-reasoning]')
    expect(reasoning).not.toBeNull()
    expect(reasoning?.textContent).toContain('first line')
    expect(reasoning?.textContent).toContain('latest tokens')
    expect(view.container.querySelector('[data-disclosure-row]')).toBeNull()
    expect(view.container.querySelector('[data-variant="think"]')).toBeNull()
    expect(view.container.querySelectorAll(`.${css.follow}`)).toHaveLength(1)
  })

  it('keeps reasoning in the ordinary Turn flow after the node settles', () => {
    const block = { kind: 'reasoning', text: 'first line\n\nsecond' }
    const view = render(<TypewriterAssistantNodeView {...assistantProps('settled', [block])} />)
    const reasoning = view.container.querySelector('[data-stream-reasoning]')
    expect(reasoning).not.toBeNull()
    expect(reasoning?.textContent).toContain('second')
    const assistant = reasoning?.closest('[data-stream-node="assistant-step"]') as HTMLElement | null
    expect(assistant?.hidden).toBe(false)
    expect(view.container.querySelector('[data-disclosure-content]')).toBeNull()
  })

  it('gives only the active final text block an announcement', () => {
    const view = render(<TypewriterAssistantNodeView {...assistantProps('running', [
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' },
    ])} />)
    expect(view.container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
  })

  it('does not hand back an unprimed host that deactivates before its first frame', () => {
    const renderProbe = (active: boolean) => (
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="probe">
            <FollowHost active={active} speedCpsRef={FOLLOW_SPEED}>probe</FollowHost>
          </div>
        </div>
      </div>
    )
    const view = render(renderProbe(true))
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390

    // Keep the host mounted but deactivate it before requestAnimationFrame can
    // prime animatedH. Cleanup must not subtract the whole scrollHeight.
    view.rerender(renderProbe(false))
    expect(port.scrollTop).toBe(390)
  })

  it('does not let a losing follow driver rewrite the shared port on cleanup', async () => {
    const renderProbe = (secondActive: boolean) => (
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="driver">
            <FollowHost active speedCpsRef={FOLLOW_SPEED}>driver</FollowHost>
          </div>
          <div data-chat-anchor-key="loser">
            <FollowHost active={secondActive} speedCpsRef={FOLLOW_SPEED}>loser</FollowHost>
          </div>
        </div>
      </div>
    )
    const view = render(renderProbe(true))
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.scrollTop).toBe(400)

    // The second host bound this port but lost the token and never primed.
    // Settling it must leave the initialized driver's visual position intact.
    view.rerender(renderProbe(false))
    expect(port.scrollTop).toBe(400)
  })

  it('ignores ResizeObserver callbacks owned by a losing follow host', async () => {
    const observers: Array<{ fire: () => void }> = []
    class ResizeObserverMock {
      readonly fire: () => void
      constructor(callback: ResizeObserverCallback) {
        this.fire = () => callback([], this as unknown as ResizeObserver)
        observers.push(this)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="driver">
            <FollowHost active speedCpsRef={FOLLOW_SPEED}>driver</FollowHost>
          </div>
          <div data-chat-anchor-key="loser">
            <FollowHost active speedCpsRef={FOLLOW_SPEED}>loser</FollowHost>
          </div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(observers).toHaveLength(2)

    port.scrollTop = 275
    observers[1]?.fire()
    expect(port.scrollTop).toBe(275)
  })

  it('does not overwrite a reader gesture when the stream closes before the next frame', async () => {
    const renderProbe = (active: boolean) => (
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <FollowHost active={active} speedCpsRef={FOLLOW_SPEED}>probe</FollowHost>
        </div>
      </div>
    )
    const view = render(renderProbe(true))
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    fireEvent.wheel(port, { deltaY: -60 })
    port.scrollTop = 320
    view.rerender(renderProbe(false))

    expect(port.scrollTop).toBe(320)
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(transcript.style.transform).toBe('')
  })

  it('settles at the floor instead of handing a near-top stale snapshot to a long port', async () => {
    const observers: Array<{ fire: () => void }> = []
    class ResizeObserverMock {
      readonly fire: () => void
      constructor(callback: ResizeObserverCallback) {
        this.fire = () => callback([], this as unknown as ResizeObserver)
        observers.push(this)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const renderProbe = (active: boolean) => (
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <FollowHost active={active} speedCpsRef={FOLLOW_SPEED}>probe</FollowHost>
        </div>
      </div>
    )
    const view = render(renderProbe(true))
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    let scrollHeight = 80
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    port.scrollTop = 0
    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(observers).toHaveLength(1)

    // A large layout batch crosses from no scroll room to a long Session while
    // animatedH still represents the original 80px extent.
    scrollHeight = 500
    observers[0]?.fire()
    expect(port.scrollTop).toBe(400)
    view.rerender(renderProbe(false))

    expect(port.scrollTop).toBe(400)
    expect(port.getAttribute('data-follow-owned')).toBeNull()
  })

  it('hands the driver token to another active host without moving the port upward', async () => {
    const renderProbe = (firstActive: boolean) => (
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <FollowHost active={firstActive} speedCpsRef={FOLLOW_SPEED}>driver</FollowHost>
          <FollowHost active speedCpsRef={FOLLOW_SPEED}>successor</FollowHost>
        </div>
      </div>
    )
    const view = render(renderProbe(true))
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.scrollTop).toBe(400)
    const shift = transcript.style.transform
    expect(shift).not.toBe('')

    view.rerender(renderProbe(false))
    expect(port.scrollTop).toBe(400)
    expect(transcript.style.transform).toBe(shift)
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(port.scrollTop).toBe(400)
    expect(transcript.style.transform).toBe(shift)
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
  })

  it('preserves the final visual snapshot when all shared hosts stop together', async () => {
    const renderProbe = (active: boolean) => (
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <FollowHost active={active} speedCpsRef={FOLLOW_SPEED}>driver</FollowHost>
          <FollowHost active={active} speedCpsRef={FOLLOW_SPEED}>peer</FollowHost>
        </div>
      </div>
    )
    const view = render(renderProbe(true))
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(port.scrollTop).toBe(400)

    view.rerender(renderProbe(false))
    expect(port.scrollTop).toBeGreaterThan(0)
    expect(port.scrollTop).toBeLessThan(400)
    expect(port.getAttribute('data-follow-owned')).toBeNull()
  })

  it('glides the growing conversation port toward the floor while streaming', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    // Start pinned near the floor so the first frame claims follow.
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(port.scrollTop).toBeGreaterThan(390)
  })

  it('releases follow on a reader pull-up and resumes only after a return to the floor', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    fireEvent.wheel(port, { deltaY: -80 })
    port.scrollTop = 40
    fireEvent.scroll(port)
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    const held = port.scrollTop
    await act(() => vi.advanceTimersByTimeAsync(2400))
    expect(port.scrollTop).toBe(held)

    port.scrollTop = 400
    fireEvent.scroll(port)
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 650 })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(port.scrollTop).toBeGreaterThan(400)
  })

  it('drops follow after the node settles so a light wheel is not pulled back', async () => {
    const block = { kind: 'reasoning', text: 'first line\n\nsecond' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    view.rerender(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('settled', [block])} />
      </div>,
    )
    const settled = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(settled, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(settled, 'scrollHeight', { configurable: true, value: 500 })
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(settled.getAttribute('data-follow-owned')).toBeNull()

    fireEvent.wheel(settled, { deltaY: -12 })
    settled.scrollTop = 370
    fireEvent.scroll(settled)
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(settled.getAttribute('data-follow-owned')).toBeNull()
    expect(settled.scrollTop).toBe(370)
  })

  it('unpins on a light upward wheel instead of requiring a 25px engine lag', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    fireEvent.wheel(port, { deltaY: -12 })
    port.scrollTop = 385
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(port.scrollTop).toBe(385)
  })

  it('unpins before a pointer-driven disclosure collapse changes layout', async () => {
    const block = { kind: 'text', text: 'line one\\n\\nline two\\n\\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    fireEvent.pointerDown(port)
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
  })

  it('hands the reader the lag-compensated position on unpin, not the engine floor', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    // Engine pinned at the floor; the glide lag rides on the transcript.
    expect(port.scrollTop).toBe(400)
    const lagBefore = Number(/translate3d\(0, ([\d.]+)px, 0\)/.exec(transcript.style.transform)?.[1] ?? -1)
    expect(lagBefore).toBeGreaterThan(0)

    // Reader pulls the engine up beyond the slack band; the effective visual
    // top is engine - lag.
    fireEvent.wheel(port, { deltaY: -60 })
    port.scrollTop = 340
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).toBeNull()
    expect(transcript.style.transform).toBe('')
    // Continuity: after the transform clears, scrollTop IS the visual top the
    // reader was seeing (engine - lag), not the pre-unpin engine position.
    expect(port.scrollTop).toBeCloseTo(340 - lagBefore, 1)
    const held = port.scrollTop
    await act(() => vi.advanceTimersByTimeAsync(2400))
    expect(port.scrollTop).toBe(held)
  })

  it('settles on the lag-compensated position when the stream closes instead of snapping to the floor', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.scrollTop).toBe(400)

    // Close while the glide still trails: the ownership handover must land on
    // the visual top (below the floor), never snap scrollTop to the floor.
    view.rerender(
      <div data-conversation-scroll>
        <div data-chat-transcript>
          <TypewriterAssistantNodeView {...assistantProps('settled', [block])} />
        </div>
      </div>,
    )
    await act(() => vi.advanceTimersByTimeAsync(48))
    expect(port.scrollTop).toBeLessThan(400)
    expect(port.scrollTop).toBeGreaterThan(0)
  })

  it('shifts message rows, not the turn-status sibling, when the host has no transcript box', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="a">
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-anchor-key="b"><span>older</span></div>
          <div role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const flow = view.container.querySelector('[data-chat-flow]') as HTMLElement
    const label = view.container.querySelector('[role="status"]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    // Engine pinned at the floor; the lag rides the message rows only.
    expect(port.scrollTop).toBe(400)
    expect(flow.style.transform).toBe('')
    expect(label.style.transform).toBe('')
    const rows = flow.querySelectorAll('[data-chat-anchor-key]')
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect((row as HTMLElement).style.transform).toMatch(/^translate3d\(0(px)?, \d/)
    }
  })

  it('shifts only the outermost rows so nested tool subcalls do not double-shift', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="a">
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
            <div data-chat-anchor-key="a:sub">
              <span>subcall</span>
            </div>
          </div>
          <div data-chat-anchor-key="b"><span>older</span></div>
          <div role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const flow = view.container.querySelector('[data-chat-flow]') as HTMLElement
    const outer = flow.querySelector('[data-chat-anchor-key="a"]') as HTMLElement
    const sub = flow.querySelector('[data-chat-anchor-key="a:sub"]') as HTMLElement
    const sibling = flow.querySelector('[data-chat-anchor-key="b"]') as HTMLElement
    const label = view.container.querySelector('[role="status"]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    // The lag rides the outermost rows only; a nested subcall row is not
    // shifted on its own (it would tear away from its parent by the lag).
    expect(outer.style.transform).toMatch(/^translate3d\(0(px)?, \d/)
    expect(sibling.style.transform).toMatch(/^translate3d\(0(px)?, \d/)
    expect(sub.style.transform).toBe('')
    expect(flow.style.transform).toBe('')
    expect(label.style.transform).toBe('')
  })

  it('keeps following when the column grows without a reader gesture', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two\n\nline three' }
    const view = render(
      <div data-conversation-scroll>
        <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 390
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 720 })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()
    expect(port.scrollTop).toBeGreaterThan(390)
  })

  it('glides the turn-status chrome down before the port has scroll room', async () => {
    const block = { kind: 'text', text: 'line one\n\nline two' }
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-transcript>
            <TypewriterAssistantNodeView {...assistantProps('running', [block])} />
          </div>
          <div data-chat-turn-status="" role="status">Deep diving...</div>
        </div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const chrome = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    // Content shorter than the viewport: the port cannot scroll, so the
    // content-height lag has no scrollTop room to ride.
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 20 })
    port.scrollTop = 0
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.getAttribute('data-follow-owned')).not.toBeNull()

    // A wrap grows the content while it is still short of the viewport. The
    // interpolated lag descends the turn-status label instead of snapping it.
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 60 })
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(port.scrollTop).toBe(0)
    expect(transcript.style.transform).toBe('')
    const chromeShift = Number(/translate3d\(0, ([\d.-]+)px, 0\)/.exec(chrome.style.transform)?.[1] ?? 0)
    // The label is descending (negative), but by less than the full 40px
    // content-height jump — it is gliding, not snapping.
    expect(chromeShift).toBeLessThan(0)
    expect(chromeShift).toBeGreaterThan(-40)

    // The lag keeps closing toward the settled position.
    await act(() => vi.advanceTimersByTimeAsync(400))
    const laterShift = Number(/translate3d\(0, ([\d.-]+)px, 0\)/.exec(chrome.style.transform)?.[1] ?? 0)
    expect(laterShift).toBeGreaterThan(chromeShift)
  })

  it('returns settled text to the Harness Markdown renderer', () => {
    const view = render(<TypewriterAssistantNodeView {...assistantProps('settled', [
      { kind: 'text', text: '**finished**' },
    ])} />)
    expect(view.getByText('finished').tagName).toBe('STRONG')
  })

  it('renders unknown blocks through JsonBlock', () => {
    const view = render(<TypewriterAssistantNodeView {...assistantProps('settled', [
      { kind: 'other', block: { type: 'mystery', value: 1 } },
    ])} />)
    expect(view.container.textContent).toContain('message.unknownBlock')
  })
})

describe('Codex-style deliverables', () => {
  it('aggregates a successful diff call into immutable turn data', () => {
    const start = deliverablesDefinition.start(
      {} as never,
      { event: { type: 'turn/start', data: { turn: 1 } } } as never,
      {} as never,
    )
    const called = deliverablesDefinition.update(
      { state: start } as never,
      {
        event: {
          type: 'tool/call',
          data: { turn: 1, step: 1, callId: 'edit-1', name: 'edit', arguments: '{}' },
        },
        view: {
          for: 'call',
          view: {
            card: 'diff',
            diffs: [{ path: 'src/App.tsx', oldText: 'old', newText: 'new\nnext' }],
          },
        },
      } as never,
    )
    const updated = deliverablesDefinition.update(
      { state: called } as never,
      {
        event: {
          type: 'tool/result',
          seq: 3,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              source: { type: 'tool-result', callId: 'edit-1' },
              content: [{ type: 'tool-result', content: [], isError: false }],
            },
          },
        },
      } as never,
    )
    const websiteCalled = deliverablesDefinition.update(
      { state: updated } as never,
      {
        event: {
          type: 'tool/call',
          data: { turn: 1, step: 1, callId: 'deploy-1', name: 'deploy_site', arguments: '{}' },
        },
      } as never,
    )
    const websiteUpdated = deliverablesDefinition.update(
      { state: websiteCalled } as never,
      {
        event: {
          type: 'tool/result',
          seq: 4,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              source: { type: 'tool-result', callId: 'deploy-1' },
              content: [{ type: 'text', text: 'Preview: https://preview.example.test' }],
            },
          },
        },
      } as never,
    )
    expect(websiteUpdated.entries).toEqual([
      { path: 'src/App.tsx', seq: 3, added: 2, removed: 1, kind: 'file' },
      { path: 'https://preview.example.test', seq: 4, added: 0, removed: 0, kind: 'website' },
    ])
    expect(DELIVERABLES_DATA_KEY).toBe('dsh-conversation-ui-deliverables')
  })

  it('falls back to the native produced-file data when available', () => {
    const owner = {
      seq: 5,
      turn: {
        data: {
          get: (key: string) => key === 'deliverables'
            ? { produced: [{ seq: 2, path: 'test-file-1.txt' }, { seq: 3, path: 'test-file-2.txt' }] }
            : undefined,
        },
      },
    }
    expect(selectDeliverables(owner as never)).toEqual([
      { seq: 2, path: 'test-file-1.txt', added: 0, removed: 0, kind: 'file' },
      { seq: 3, path: 'test-file-2.txt', added: 0, removed: 0, kind: 'file' },
    ])
  })

  it('renders expandable file rows and opens website deliverables externally', () => {
    const openFile = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const view = render(
      <DeliverablesCard
        matched={[
          { path: '/workspace/src/App.tsx', seq: 1, added: 2, removed: 1, kind: 'file' },
          { path: '/workspace/src/App.css', seq: 1, added: 4, removed: 0, kind: 'file' },
          { path: '/workspace/README.md', seq: 1, added: 1, removed: 0, kind: 'file' },
          { path: '/workspace/index.html', seq: 1, added: 8, removed: 2, kind: 'file' },
          { path: 'https://preview.example.test', seq: 1, added: 0, removed: 0, kind: 'website' },
        ]}
        turn={{ data: { get: () => undefined } } as never}
        seq={2}
        openFile={openFile}
      />,
    )
    expect(view.getByText('已交付 5 项产物')).toBeTruthy()
    expect(view.getByText('+2')).toBeTruthy()
    expect(view.getByText('-1')).toBeTruthy()
    expect(view.getByRole('button', { name: /再显示 2 个产物/ })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /再显示 2 个产物/ }))
    fireEvent.click(view.getByTitle('/workspace/src/App.tsx'))
    expect(openFile).toHaveBeenCalledWith('/workspace/src/App.tsx')
    fireEvent.click(view.getByTitle('https://preview.example.test'))
    expect(open).toHaveBeenCalledWith('https://preview.example.test', '_blank', 'noopener,noreferrer')
  })
})

describe('client plugin lifecycle', () => {
  it('shadows the built-in assistant cell and removes its entry on disposal', async () => {
    expect(inject).toEqual(['slots'])
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'tool-call',
    } as never, (() => null) as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const keys = ctx.slots.entries('conversation.chat.node').map(entry => entry.options.key)
    expect(keys).toEqual(expect.arrayContaining(['assistant-step', 'tool-call']))

    await fiber.dispose()
    const leftover = ctx.slots.entries('conversation.chat.node')
    expect(leftover).toHaveLength(1)
    expect(leftover[0]?.options.key).toBe('tool-call')
  })

  it('elects the Codex tail card before the built-in deliverables claimant', async () => {
    function NativeProducedFiles() { return null }
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.turnTail': { kind: 'chain', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.turnTail',
      select: () => ['native.txt'],
      registrant: 'native-deliverables',
    } as never, NativeProducedFiles as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entries = ctx.slots.entries('conversation.chat.turnTail')
    expect(entries).toHaveLength(2)
    expect(entries[0]?.component).toBe(DeliverablesCard)
    expect(entries[0]?.options.priority).toBe(-100)
    expect(entries[1]?.component).toBe(NativeProducedFiles)

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.chat.turnTail')[0]?.component).toBe(NativeProducedFiles)
  })

  it('registers the delivery data definition and tail card when conversation events are available', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    await ctx.plugin(ConversationEventRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.turnTail': { kind: 'chain', scope: 'session' } },
    } as never, (() => null) as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.chat.turnTail')[0]?.component).toBe(DeliverablesCard)
    expect(ctx.get('conversationEvents')?.entries().some(entry => entry.kind === DELIVERABLES_DATA_KEY)).toBe(true)

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
    expect(ctx.get('conversationEvents')?.entries().some(entry => entry.kind === DELIVERABLES_DATA_KEY)).toBe(false)
  })

  it('wraps a prior tool-call that already declared children without re-registering', async () => {
    function DummyTool({ node }: { node: { data: { root: object } } }) {
      return <div>tool:{'kind' in node.data.root ? 'settled' : 'running'}</div>
    }
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'tool-call',
      children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
    } as never, DummyTool as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')
    expect(entry?.component).not.toBe(DummyTool)
    const view = render(createElement(entry?.component as FunctionComponent<{ node: { data: { root: object } } }>, {
      node: { data: { root: { callId: '1', name: 'bash' } } },
    }))
    expect(view.container.querySelector(`.${css.follow}`)).not.toBeNull()
    expect(view.container.textContent).toContain('tool:running')

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')?.component).toBe(DummyTool)
  })

  it('wraps memoized built-in rows such as context injection', async () => {
    const MemoContext = memo(function MemoContext() {
      return <div>context injection</div>
    })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'context',
    } as never, MemoContext as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'context')
    expect(entry?.component).not.toBe(MemoContext)
    await fiber.dispose()
  })

  it('wraps a tool-call registered after the overlay mounts', async () => {
    function LateTool() {
      return <div>late</div>
    }
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'tool-call',
    } as never, LateTool as never)
    const entry = ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')
    expect(entry?.component).not.toBe(LateTool)
    const view = render(createElement(entry?.component as FunctionComponent<{ node: { data: { root: object } } }>, {
      node: { data: { root: { callId: '2', name: 'read' } } },
    }))
    expect(view.container.querySelector(`.${css.follow}`)).not.toBeNull()
    expect(view.container.textContent).toContain('late')
    await fiber.dispose()
  })

  async function renderRegisteredView(props: Parameters<typeof TypewriterAssistantNodeView>[0]): Promise<HTMLElement> {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const component = ctx.slots.entries('conversation.chat.node')[0]?.component
    expect(component).toBeTypeOf('function')
    const view = render(createElement(component as FunctionComponent<Parameters<typeof TypewriterAssistantNodeView>[0]>, props))
    await fiber.dispose()
    return view.container
  }

  it('applies the Host-bridged config to the registered view', async () => {
    ;(globalThis as Record<string, unknown>)[CONVERSATION_BOOT_GLOBAL] = {
      ...DEFAULT_CONVERSATION_CONFIG,
      mode: 'teleprompter',
      preset: 'silky',
      scrollSpeedPxPerSec: 60,
      maxScrollSpeedPxPerSec: 200,
    }
    const container = await renderRegisteredView(assistantProps('running', [
      { kind: 'text', text: 'hello' },
    ]))
    expect(container.querySelector(`.${css.follow}`)).not.toBeNull()
    delete (globalThis as Record<string, unknown>)[CONVERSATION_BOOT_GLOBAL]
  })

  it('falls back to defaults without the Host config bridge', async () => {
    delete (globalThis as Record<string, unknown>)[CONVERSATION_BOOT_GLOBAL]
    const container = await renderRegisteredView(assistantProps('running', [
      { kind: 'text', text: '**hello**' },
    ]))
    // Default mode is Codex-style teleprompter: follow host + markdown parsed.
    expect(container.querySelector(`.${css.follow}`)).not.toBeNull()
    expect(container.querySelector('strong')?.textContent).toBe('hello')
  })

  it('fails loudly on a malformed boot global', async () => {
    ;(globalThis as Record<string, unknown>)[CONVERSATION_BOOT_GLOBAL] = { mode: 'diagonal' }
    await expect(renderRegisteredView(assistantProps('running', [
      { kind: 'text', text: 'hello' },
    ]))).rejects.toThrow(/malformed/)
    delete (globalThis as Record<string, unknown>)[CONVERSATION_BOOT_GLOBAL]
  })
})

describe('plugin Config schema', () => {
  it('fills defaults when the overlay config is omitted', () => {
    const resolved = Config({} as never)
    expect(resolved).toEqual(DEFAULT_CONVERSATION_CONFIG)
  })

  it('accepts a full override and rejects invalid values', () => {
    const resolved = Config({
      mode: 'teleprompter',
      preset: 'realtime',
      revealCharsPerSec: 60,
      scrollSpeedPxPerSec: 100,
      maxScrollSpeedPxPerSec: 400,
    })
    expect(resolved).toEqual({
      mode: 'teleprompter',
      preset: 'realtime',
      revealCharsPerSec: 60,
      scrollSpeedPxPerSec: 100,
      maxScrollSpeedPxPerSec: 400,
    })
    expect(() => Config({ mode: 'diagonal' } as never)).toThrow()
    expect(() => Config({ scrollSpeedPxPerSec: 0 } as never)).toThrow()
    expect(() => Config({ maxScrollSpeedPxPerSec: 9000 } as never)).toThrow()
    expect(() => Config({ revealCharsPerSec: 0 } as never)).toThrow()
  })
})

describe('computeQueueReveal', () => {
  it('types one glyph per frame when the queue is small', () => {
    expect(computeQueueReveal(3, 16.67)).toBe(1)
  })

  it('raises the step when the queue is backlogged', () => {
    expect(computeQueueReveal(40, 16.67)).toBe(5)
    expect(computeQueueReveal(80, 16.67)).toBe(10)
  })

  it('never exceeds the backlog', () => {
    expect(computeQueueReveal(2, 1000)).toBe(2)
    expect(computeQueueReveal(0, 16)).toBe(0)
  })
})

describe('computeSettleDrain', () => {
  it('drains ordinary backlog within the settle window', () => {
    const config = PRESET_CONFIG.balanced
    const ordinary = computeSettleDrain(config, { backlog: 200, inputActive: false, settling: true })
    expect(ordinary).toBeGreaterThanOrEqual(config.flushCps)
    expect(ordinary).toBeLessThanOrEqual(config.maxFlushCps)
  })

  it('climbs past the settle window to close a backlog beyond the lag ceiling', () => {
    const config = PRESET_CONFIG.balanced
    const lagged = computeSettleDrain(config, { backlog: 2000, inputActive: false, settling: true })
    const ordinary = computeSettleDrain(config, { backlog: 50, inputActive: false, settling: true })
    expect(lagged).toBeGreaterThan(ordinary)
    expect(lagged).toBe(config.maxFlushCps)
    // Ceiling drain alone closes a 2000-char backlog within two seconds:
    // the whole reply drains at maxFlushCps while the overflow pays for itself.
    expect((2000 - BACKLOG_CHAR_CEILING) * 1000 / BACKLOG_SECOND_CEILING).toBeGreaterThan(config.maxFlushCps)
  })

  it('stays in the settle band while input is still active or not yet settling', () => {
    const config = PRESET_CONFIG.balanced
    expect(computeSettleDrain(config, { backlog: 5000, inputActive: true, settling: false })).toBe(0)
    expect(computeSettleDrain(config, { backlog: 5000, inputActive: false, settling: false })).toBe(0)
  })
})

describe('isGrowingChatNode', () => {
  it('treats running assistant, unsettled tools, and scheduled retries as growing', () => {
    expect(isGrowingChatNode({ data: { status: 'running', blocks: [] } })).toBe(true)
    expect(isGrowingChatNode({ data: { status: 'settled', blocks: [] } })).toBe(false)
    expect(isGrowingChatNode({ data: { root: { callId: '1', name: 'bash' } } })).toBe(true)
    expect(isGrowingChatNode({ data: { root: { kind: 'tool-result', callId: '1' } } })).toBe(false)
    expect(isGrowingChatNode({ data: { current: { retryState: 'scheduled' } } })).toBe(true)
    expect(isGrowingChatNode({ data: { current: { retryState: 'done' } } })).toBe(false)
  })

  it('hosts follow only while the wrapped node is growing', () => {
    function Inner({ node }: { node: { data: { root: object } } }) {
      return <span>{'kind' in node.data.root ? 'done' : 'live'}</span>
    }
    const Wrapped = wrapFollowNodeView(Inner as never)
    const live = render(<Wrapped node={{ kind: 'tool-call', data: { root: { callId: '1' } } }} />)
    expect(live.container.querySelector(`.${css.follow}`)).not.toBeNull()
    expect(live.container.querySelector('[data-stream-node="tool-call"][data-stream-state="running"]')).not.toBeNull()
    expect(live.container.textContent).toBe('live')
    const done = render(<Wrapped node={{ kind: 'tool-call', data: { root: { kind: 'tool-result', callId: '1' } } }} />)
    expect(done.container.querySelector('[data-stream-node="tool-call"][data-stream-state="settled"]')).not.toBeNull()
    expect(done.container.textContent).toBe('done')
  })
})

describe('Turn prelude', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE] }))

  it('shows the processed clock, divider, and shimmering waiting state before any process node exists', async () => {
    vi.setSystemTime(new Date(10_000))
    function UserFixture() {
      return <div>the user question</div>
    }
    const WrappedUser = wrapTurnPreludeNodeView(UserFixture)
    const userNode = {
      key: 'user-waiting-1',
      kind: 'user',
      anchorSeq: 10,
      location: { kind: 'session' },
      data: { kind: 'user', seq: 10, time: 10_000, content: [], source: { kind: 'user' } },
    }
    const snapshot = {
      running: true,
      chat: {
        order: [userNode.key],
        nodes: { get: (key: string) => key === userNode.key ? userNode : undefined },
        timeline: { turnOrder: [], turns: new Map() },
      },
    }
    const useSession = (selector: (value: typeof snapshot) => unknown) => selector(snapshot)
    const view = render(<WrappedUser
      sessionId="prelude-session"
      node={userNode}
      useSession={useSession}
      t={assistantProps('running', []).t}
    />)

    const row = view.container.querySelector('[data-turn-fold-state="running"]') as HTMLElement
    expect(row.textContent).toContain('已处理 0秒')
    expect(view.getByText('思考中').getAttribute('data-turn-waiting')).not.toBeNull()
    expect(view.container.querySelector('[data-turn-process]')).toBeNull()
    expect((view.getByText('the user question') as Node).compareDocumentPosition(row)
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(row.textContent).toContain('已处理 1秒')

    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    expect(styleSheet).toMatch(/\.turnWaiting\s*{[^}]*background-clip:\s*text/s)
    expect(styleSheet).toMatch(/\.turnWaiting\s*{[^}]*animation:\s*dsh-turn-waiting-shimmer/s)
  })

  it('replaces the waiting placeholder when the first real process node arrives', () => {
    function UserFixture() {
      return <div>the user question</div>
    }
    function ToolFixture() {
      return <div>real tool stream</div>
    }
    const WrappedUser = wrapTurnPreludeNodeView(UserFixture)
    const WrappedTool = wrapFollowNodeView(ToolFixture)
    const userNode = {
      key: 'user-waiting-2',
      kind: 'user',
      anchorSeq: 20,
      location: { kind: 'session' },
      data: { kind: 'user', seq: 20, time: 20_000, content: [], source: { kind: 'user' } },
    }
    const turn = {
      turn: 4,
      status: 'open',
      start: { seq: 19, time: 20_000 },
      end: undefined,
    }
    const toolNode = {
      key: 'tool-waiting-2',
      kind: 'tool-call',
      anchorSeq: 22,
      location: { kind: 'step', turn, step: { step: 1 } },
      data: { root: { callId: 'call-waiting-2', name: 'read_file' } },
    }
    const snapshot = {
      running: true,
      chat: {
        order: [userNode.key, toolNode.key],
        nodes: { get: (key: string) => key === userNode.key ? userNode : toolNode },
        timeline: { turnOrder: [turn.turn], turns: new Map([[turn.turn, turn]]) },
      },
    }
    const useSession = (selector: (value: typeof snapshot) => unknown) => selector(snapshot)
    const view = render(<>
      <WrappedUser
        sessionId="prelude-session-2"
        node={userNode}
        useSession={useSession}
        t={assistantProps('running', []).t}
      />
      <WrappedTool sessionId="prelude-session-2" node={toolNode} />
    </>)

    expect(view.queryByText('思考中')).toBeNull()
    expect(view.getByText('real tool stream')).not.toBeNull()
    expect(view.container.querySelectorAll('[data-turn-fold-row]')).toHaveLength(1)
  })

  it('keeps the user-anchored disclosure above every process row after completion', () => {
    function UserFixture() {
      return <div>completed user question</div>
    }
    const WrappedUser = wrapTurnPreludeNodeView(UserFixture)
    const turn = {
      turn: 8,
      status: 'closed',
      start: { seq: 80, time: 1_000 },
      end: { seq: 99, time: 4_000, data: { reason: { kind: 'completed' } } },
    }
    const userNode = {
      key: 'user-complete-8',
      kind: 'user',
      anchorSeq: 82,
      location: { kind: 'step', turn, step: { step: 1 } },
      data: { kind: 'user', seq: 82, time: 1_100, content: [], source: { kind: 'user' } },
    }
    const snapshot = {
      running: false,
      chat: {
        order: [userNode.key],
        nodes: { get: (key: string) => key === userNode.key ? userNode : undefined },
        timeline: { turnOrder: [turn.turn], turns: new Map([[turn.turn, turn]]) },
      },
    }
    const useSession = (selector: (value: typeof snapshot) => unknown) => selector(snapshot)
    const view = render(<>
      <WrappedUser
        sessionId="prelude-session-8"
        node={userNode}
        useSession={useSession}
        t={assistantProps('running', []).t}
      />
      <TypewriterAssistantNodeView {...assistantProps('settled', [
        { kind: 'text', text: 'all process content' },
      ], {
        completed: true,
        nodeKey: 'prelude-process-8',
        sessionId: 'prelude-session-8',
        turnNumber: 8,
      })} />
      <TypewriterAssistantNodeView {...assistantProps('settled', [
        { kind: 'text', text: 'visible final content' },
      ], {
        closing: true,
        completed: true,
        nodeKey: 'prelude-final-8',
        sessionId: 'prelude-session-8',
        turnNumber: 8,
      })} />
    </>)

    const user = view.getByText('completed user question')
    const toggle = view.getByRole('button', { name: /耗时/ })
    const process = view.getByText('all process content').closest('[data-turn-process]') as HTMLElement
    const final = view.getByText('visible final content').closest('[data-stream-phase="final"]') as HTMLElement
    expect(view.container.querySelectorAll('[data-turn-fold-row]')).toHaveLength(1)
    expect(user.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(toggle.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(process.hidden).toBe(true)
    expect(final.hidden).toBe(false)
  })
})

describe('Codex-style Tool presentation', () => {
  it.each([
    ['smops_knowledge_search', 'search'],
    ['read_file', 'read'],
    ['apply_patch', 'edit'],
    ['bash', 'terminal'],
    ['query_database', 'data'],
    ['smops_schema_get', 'data'],
    ['smops_sql_plan', 'data'],
    ['smops_memory_save', 'data'],
    ['smops_guardian_log_query', 'search'],
    ['smops_scope', 'settings'],
    ['mcp__codegraph__codegraph_explore', 'code'],
    ['mcp__codegraph__codegraph_callers', 'code'],
    ['web_fetch', 'web'],
    ['execute_code', 'code'],
    ['load_skill', 'skill'],
    ['create_subagent', 'agent'],
    ['cordis_plugin_list', 'plugin'],
    ['request_user_input', 'question'],
    ['update_plan', 'checklist'],
    ['unknown_custom_tool', 'other'],
  ])('maps %s to the %s semantic icon family', (toolName, expected) => {
    expect(semanticToolKind(toolName)).toBe(expected)
  })

  it('derives +/- line counts for an edit summary suffix', () => {
    const node = {
      data: {
        root: {
          name: 'edit',
          resultView: {
            card: 'diff',
            diffs: [{ path: 'README.md', oldText: 'old line', newText: 'new line\\nsecond line\\n' }],
          },
        },
      },
    }
    expect(editDiffStats(node)).toBe('+2 -1')
    expect(editDiffStats({
      data: {
        root: {
          name: 'edit',
          resultView: { card: 'diff', diffs: [{ path: 'README.md', oldText: 'a\nb', newText: 'a\nb\nc' }] },
        },
      },
    })).toBe('+3 -2')
    expect(editDiffStats({
      data: { root: { name: 'edit', isError: true, resultView: node.data.root.resultView } },
    })).toBeUndefined()
    expect(editDiffStats({ data: { root: { name: 'read', callView: { card: 'diff', diffs: [] } } } })).toBeUndefined()
  })

  it('groups contiguous same-kind commands into one activity block', () => {
    const turn = { turn: 12, status: 'open', start: { time: 1_000 } }
    const first = {
      key: 'command-1',
      kind: 'tool-call',
      visibility: 'visible',
      location: { kind: 'step', turn, step: { step: 1 } },
      data: { root: { callId: 'command-1', name: 'bash' } },
    }
    const second = {
      key: 'command-2',
      kind: 'tool-call',
      visibility: 'visible',
      location: { kind: 'step', turn, step: { step: 2 } },
      data: { root: { kind: 'tool-result', callId: 'command-2', name: 'bash' } },
    }
    const read = {
      key: 'read-1',
      kind: 'tool-call',
      visibility: 'visible',
      location: { kind: 'step', turn, step: { step: 3 } },
      data: { root: { kind: 'tool-result', callId: 'read-1', name: 'read_file' } },
    }
    const nodes = new Map([[first.key, first], [second.key, second], [read.key, read]])
    const snapshot = {
      chat: { order: [first.key, second.key, read.key], nodes: { get: (key: string) => nodes.get(key) } },
    }
    const firstGroup = toolActivityGroup(snapshot, first.key, 'session-group', turn.turn, 'terminal')
    const secondGroup = toolActivityGroup(snapshot, second.key, 'session-group', turn.turn, 'terminal')
    const readGroup = toolActivityGroup(snapshot, read.key, 'session-group', turn.turn, 'read')

    expect(firstGroup).toMatchObject({ label: '运行了命令', count: 2, position: 'start', hasGrowing: true })
    expect(secondGroup).toMatchObject({ label: '运行了命令', count: 2, position: 'end' })
    expect(secondGroup?.id).toBe(firstGroup?.id)
    expect(readGroup).toBeUndefined()
  })

  it('groups contiguous Prompt context rows into one activity block', () => {
    const first = { key: 'prompt-1', kind: 'context', visibility: 'visible', location: { kind: 'session' }, data: { seq: 1 } }
    const second = { key: 'prompt-2', kind: 'context', visibility: 'visible', location: { kind: 'session' }, data: { seq: 2 } }
    const nodes = new Map([[first.key, first], [second.key, second]])
    const snapshot = {
      chat: { order: [first.key, second.key], nodes: { get: (key: string) => nodes.get(key) } },
    }
    const group = nativeActivityGroup(snapshot, first.key, 'prompt-session', 4, 'context')
    expect(group).toMatchObject({ label: '注入了 Prompt', count: 2, position: 'start' })
  })

  it('renders contiguous command rows inside one shared activity frame', async () => {
    function ToolFixture() {
      return (
        <div data-chat-call-id="fixture-call">
          <div data-slot="tool.call.toolview">
            <div data-tool="bash">
              <div>
                <div data-disclosure-row aria-expanded="false">
                  <span><span>run command</span><svg /></span>
                  <span>bash</span>
                  <span>command output</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    }
    const turn = { turn: 13, status: 'open', start: { time: 1_000 } }
    const first = {
      key: 'group-command-1',
      kind: 'tool-call',
      visibility: 'visible',
      anchorSeq: 1,
      location: { kind: 'step', turn, step: { step: 1 } },
      data: { root: { callId: 'group-command-1', name: 'bash' } },
    }
    const second = {
      key: 'group-command-2',
      kind: 'tool-call',
      visibility: 'visible',
      anchorSeq: 2,
      location: { kind: 'step', turn, step: { step: 2 } },
      data: { root: { kind: 'tool-result', callId: 'group-command-2', name: 'bash' } },
    }
    const nodes = new Map([[first.key, first], [second.key, second]])
    let snapshot = {
      running: true,
      chat: { order: [first.key, second.key], nodes: { get: (key: string) => nodes.get(key) } },
    }
    const useSession = (selector: (value: typeof snapshot) => unknown) => selector(snapshot)
    const Wrapped = wrapFollowNodeView(ToolFixture)
    const view = render(<>
      <Wrapped node={first} sessionId="group-session" useSession={useSession} />
      <Wrapped node={second} sessionId="group-session" useSession={useSession} />
    </>)
    const frame = await waitFor(() => {
      const element = view.container.querySelector('[data-stream-tool-group-frame]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(frame.querySelectorAll('[data-stream-tool-group-member]')).toHaveLength(2)
    expect(frame.querySelectorAll('[data-chat-call-id]')).toHaveLength(2)
    const toggle = frame.querySelector('[data-stream-tool-group-toggle]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    // The running batch stays open while work is arriving, then collapses as
    // soon as every member settles.
    nodes.set(first.key, {
      ...first,
      data: { root: Object.assign({}, first.data.root, { kind: 'tool-result' }) },
    })
    snapshot = { ...snapshot, running: false }
    view.rerender(<>
      <Wrapped node={first} sessionId="group-session" useSession={useSession} />
      <Wrapped node={second} sessionId="group-session" useSession={useSession} />
    </>)
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'))
    expect(frame.querySelector('[data-tool-group-member][hidden]')).not.toBeNull()

    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    expect(styleSheet).toMatch(/\.toolGroupHeader\s*{[^}]*position:\s*relative[^}]*padding:\s*2px 8px 2px 22px/s)
    expect(styleSheet).toMatch(/\.toolGroupHeaderIcon\s*{[^}]*position:\s*absolute[^}]*inset-block-start:\s*50%[^}]*inset-inline-start:\s*0[^}]*transform:\s*translateY\(-50%\)[^}]*width:\s*14px[^}]*height:\s*14px/s)
    expect(styleSheet).toMatch(/\.toolGroupFrame \.toolSemanticIcon,[\s\S]*\.toolGroupFrame \.streamSemanticIcon\s*{[^}]*inset-block-start:\s*4px[^}]*transform:\s*none/s)
    expect(styleSheet).toMatch(/\.toolSemanticIcon,\s*\.streamSemanticIcon\s*{[^}]*inset-inline-start:\s*0/s)
    expect(styleSheet).toMatch(/\.toolGroupFrame\s*{[^}]*background:\s*transparent/s)
    expect(styleSheet).toMatch(/\.toolGroupHeader\s*{[^}]*border:\s*0/s)
    expect(styleSheet).toMatch(/\.toolGroupHeader:focus-visible\s*{[^}]*outline:\s*none[^}]*background:\s*transparent/s)
    expect(styleSheet).toMatch(/\.toolGroupHeader:hover\s*{[^}]*background:\s*transparent/s)
    expect(styleSheet).toMatch(/\.toolGroupHeaderChevron\s*{[^}]*margin-inline-start:\s*0[^}]*flex:\s*none/s)
    expect(styleSheet).toMatch(/\.editStats\s*{[^}]*flex:\s*none[^}]*margin-inline-start:\s*4px[^}]*font-size:\s*14px[^}]*line-height:\s*24px/s)
    expect(styleSheet).toMatch(/\.reasoningText\s*{[^}]*font-size:\s*14px[^}]*font-weight:\s*400[^}]*line-height:\s*24px/s)
    expect(styleSheet).toMatch(/\.reasoningText\s*>\s*:global\(div\)\s*{[^}]*font-size:\s*14px[^}]*font-weight:\s*400[^}]*line-height:\s*24px/s)
    expect(styleSheet).toMatch(/\.reasoningText\s*:global\(p\)[\s\S]*font-size:\s*14px[\s\S]*line-height:\s*24px/s)
    expect(styleSheet).toMatch(/\.reasoningText\s*:global\(strong\)[\s\S]*font-weight:\s*400/s)
    expect(styleSheet).toMatch(/\.root\[data-stream-phase='streaming'\][\s\S]*\.markdownFlow\s*>\s*:global\(div\)[\s\S]*font-size:\s*16px[\s\S]*line-height:\s*28px/s)
    expect(styleSheet).toMatch(/\.root\[data-stream-phase='streaming'\][\s\S]*\.markdownFlow\s*:global\(strong\)[\s\S]*font-weight:\s*400/s)
    expect(styleSheet).toMatch(/\.root \.markdownFlow\s*:global\(pre\)\s*{[\s\S]*max-height:\s*min\(60vh, 480px\)[\s\S]*overflow:\s*auto[\s\S]*white-space:\s*pre[\s\S]*word-break:\s*normal/s)
    expect(styleSheet).toMatch(/\.eventRow\[data-stream-node='compaction'\][\s\S]*data-compaction-disclosure[\s\S]*display:\s*none/s)
    expect(styleSheet).toMatch(/data-compaction-icon[\s\S]*focus-visible[\s\S]*background:\s*transparent !important/s)
    expect(styleSheet).toMatch(/data-compaction-icon[\s\S]*color:\s*var\(--dsw-alias-label-secondary\) !important/s)
    expect(styleSheet).toMatch(/data-compaction-icon[\s\S]*color:\s*var\(--dsw-alias-label-secondary\) !important[\s\S]*opacity:\s*1 !important/s)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(frame.querySelector('[data-tool-group-member][hidden]')).not.toBeNull()
  })

  it('appends edit +/- counts after the native file summary', async () => {
    function EditFixture() {
      const [open, setOpen] = useState(false)
      return (
        <div data-chat-call-id="edit-call">
          <div data-slot="tool.call.toolview">
            <div data-tool="edit">
              <div
                data-disclosure-row
                data-expandable=""
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
              >
                <span>leading</span>
                <span>Edit</span>
                <span>README.md</span>
              </div>
            </div>
          </div>
        </div>
      )
    }
    const turn = { turn: 14, status: 'open', start: { time: 1_000 } }
    const node = {
      key: 'edit-summary-1',
      kind: 'tool-call',
      visibility: 'visible',
      location: { kind: 'step', turn, step: { step: 1 } },
      data: {
        root: {
          callId: 'edit-call',
          name: 'edit',
          callView: {
            card: 'diff',
            diffs: [{ path: 'README.md', oldText: 'old', newText: 'new\\nnext' }],
          },
        },
      },
    }
    const snapshot = {
      running: true,
      chat: { order: [node.key], nodes: { get: () => node } },
    }
    const useSession = (selector: (value: typeof snapshot) => unknown) => selector(snapshot)
    const Wrapped = wrapFollowNodeView(EditFixture)
    const view = render(<Wrapped node={node} sessionId="edit-session" useSession={useSession} />)
    await waitFor(() => expect(view.container.querySelector('[data-stream-edit-stats]')).not.toBeNull())
    const stats = view.getByText('+2 -1')
    expect(stats).toBeTruthy()
    fireEvent.click(stats)
    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a semantic icon at the start and marks the Tool row for a trailing disclosure', () => {
    function ToolFixture() {
      return (
        <div data-chat-call-id="call-1">
          <div data-slot="tool.call.toolview">
            <div data-tool="smops_knowledge_search">
              <div>
                <div data-disclosure-row aria-expanded="false">
                  <span><span>sparkle</span><svg /></span>
                  <span>Tool call</span>
                  <span>smops_knowledge_search</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    }

    const Wrapped = wrapFollowNodeView(ToolFixture)
    const view = render(<Wrapped node={{
      kind: 'tool-call',
      data: { root: { callId: 'call-1', name: 'smops_knowledge_search' } },
    }} />)

    const event = view.container.querySelector('[data-stream-node="tool-call"]')
    const semanticIcon = event?.querySelector('[data-tool-semantic-icon="search"]')
    expect(event?.getAttribute('data-tool-semantic')).toBe('search')
    expect(semanticIcon).not.toBeNull()
    expect((semanticIcon as Node).compareDocumentPosition(view.getByText('Tool call'))
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    expect(styleSheet).toMatch(/data-stream-tool-row[\s\S]*data-disclosure-row[\s\S]*aria-expanded[\s\S]*> :first-child\s*{[^}]*display:\s*contents/s)
    expect(styleSheet).toMatch(/> :first-child\s*> :first-child:not\(:last-child\)\s*{[^}]*display:\s*none/s)
    expect(styleSheet).toMatch(/> :first-child\s*> svg\s*{[^}]*order:\s*4/s)
    expect(styleSheet).toMatch(/aria-expanded='false'[\s\S]*> svg\s*{[^}]*rotate\(-90deg\)/s)
    expect(styleSheet).toMatch(/data-sample='bash'[\s\S]*aria-expanded[\s\S]*> :first-child\s*{[^}]*display:\s*contents/s)
  })

  it('keeps a nested Tool semantic icon visible after its result is expanded', async () => {
    function NestedToolFixture() {
      const [open, setOpen] = useState(false)
      return (
        <div data-chat-call-id="root-call">
          <div data-slot="tool.call.toolview"><div data-tool="code" /></div>
          <div data-subcalls>
            <div data-chat-call-id="child-call">
              <div data-slot="tool.call.toolview">
                <div data-tool="glob" data-state="ok">
                  <div>
                    <div
                      data-disclosure-row
                      aria-expanded={open}
                      role="button"
                      tabIndex={0}
                      onClick={() => { setOpen(value => !value) }}
                    >
                      <span>
                        {!open && <span data-native-icon><svg /></span>}
                        <svg data-native-chevron />
                      </span>
                      <span>Glob</span>
                      <span>*</span>
                    </div>
                    {open && <div>glob result</div>}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    }

    const Wrapped = wrapFollowNodeView(NestedToolFixture)
    const view = render(<Wrapped node={{
      kind: 'tool-call',
      data: { root: { callId: 'root-call', name: 'execute_code' } },
    }} />)
    const row = view.getByRole('button', { name: /Glob\s+\*/ })
    const event = view.container.querySelector('[data-stream-node="tool-call"]') as HTMLElement

    expect(nestedToolIconTargets(event)).toHaveLength(1)
    await waitFor(() => {
      expect(row.querySelector('[data-stream-nested-tool-icon="search"]')).not.toBeNull()
    })
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(row.querySelector('[data-native-icon]')).toBeNull()
    await waitFor(() => {
      expect(row.querySelector('[data-stream-nested-tool-icon="search"]')).not.toBeNull()
    })
  })

  it('moves nested Tool subcall chevrons behind their title with root-row icon spacing', () => {
    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    const nestedRules = styleSheet.slice(styleSheet.indexOf('/* Nested ToolCallBranch'))

    expect(nestedRules).toMatch(/data-subcalls[\s\S]*data-chat-call-id[\s\S]*data-disclosure-row[\s\S]*> :first-child\s*{[^}]*display:\s*contents/s)
    expect(nestedRules).toMatch(/data-subcalls[\s\S]*data-disclosure-row[\s\S]*> :first-child\s*> svg\s*{[^}]*order:\s*4/s)
    expect(nestedRules).toMatch(/data-subcalls[\s\S]*data-disclosure-row[\s\S]*> :first-child\s*> svg\s*{[^}]*opacity:\s*0/s)
    expect(nestedRules).toMatch(/data-subcalls[\s\S]*data-disclosure-row[^}]*:hover[\s\S]*> svg\s*{[^}]*opacity:\s*1/s)
    expect(nestedRules).toMatch(/data-disclosure-row[\s\S]*:has\(> \.nestedToolSemanticIcon\)[^{]*{[^}]*padding-inline-start:\s*22px/s)
    expect(nestedRules).toMatch(/:has\(> \.nestedToolSemanticIcon\)[\s\S]*> :first-child[\s\S]*> :first-child:not\(:last-child\)[^{]*{[^}]*display:\s*none/s)
    expect(nestedRules).toMatch(/data-subcalls[\s\S]*data-sample='bash'[\s\S]*> :first-child\s*> svg\s*{[^}]*order:\s*4/s)
  })

  it('uses the Codex wrench glyph for code and unknown Tool families', () => {
    function ToolFixture() {
      return <div>tool body</div>
    }
    const Wrapped = wrapFollowNodeView(ToolFixture)

    const code = render(<Wrapped node={{
      kind: 'tool-call',
      data: { root: { callId: 'code-1', name: 'mcp__codegraph__codegraph_callers' } },
    }} />)
    expect(code.container.querySelector('[data-tool-semantic-icon="code"]')
      ?.getAttribute('data-tool-glyph')).toBe('wrench')

    const unknown = render(<Wrapped node={{
      kind: 'tool-call',
      data: { root: { callId: 'other-1', name: 'unknown_custom_tool' } },
    }} />)
    expect(unknown.container.querySelector('[data-tool-semantic-icon="other"]')
      ?.getAttribute('data-tool-glyph')).toBe('wrench')
  })

  it('keeps native Stream semantics leading and moves every disclosure chevron trailing', () => {
    function ContextFixture() {
      return (
        <div>
          <div data-disclosure-row aria-expanded="true">
            <span><svg data-native-chevron /></span>
            <span>上下文注入</span>
            <span>@deepseek-ai/dsh-system-prompt</span>
          </div>
        </div>
      )
    }
    const Wrapped = wrapFollowNodeView(ContextFixture)
    const view = render(<Wrapped node={{ kind: 'context', data: {} }} />)
    const event = view.container.querySelector('[data-stream-node="context"]')
    const semanticIcon = event?.querySelector('[data-stream-semantic-icon="context"]')
    expect(semanticIcon).not.toBeNull()
    expect((semanticIcon as Node).compareDocumentPosition(view.getByText('上下文注入'))
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    expect(styleSheet).toMatch(/data-stream-native-disclosure[\s\S]*data-disclosure-row[\s\S]*> :first-child\s*{[^}]*display:\s*contents/s)
    expect(styleSheet).toMatch(/data-stream-native-disclosure[\s\S]*data-disclosure-row[\s\S]*> :first-child\s*> svg[\s\S]*order:\s*4/s)
    expect(styleSheet).toMatch(/data-stream-native-disclosure[\s\S]*> :first-child\s*> svg\s*{[^}]*opacity:\s*0/s)
    expect(styleSheet).toMatch(/data-stream-native-disclosure[\s\S]*data-disclosure-row[^}]*:hover[\s\S]*> svg\s*{[^}]*opacity:\s*1/s)
  })

  it('hides item chevrons until the disclosure row is hovered or keyboard-focused', () => {
    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    expect(styleSheet).toMatch(/\.disclosureTrailing\s*{[^}]*opacity:\s*0/s)
    expect(styleSheet).toMatch(/\.disclosureRow:hover \.disclosureTrailing[\s\S]*opacity:\s*1/s)
    expect(styleSheet).toMatch(/data-stream-tool-row[\s\S]*> :first-child\s*> svg\s*{[^}]*opacity:\s*0/s)
    expect(styleSheet).toMatch(/data-disclosure-row[^}]*:hover[\s\S]*> svg\s*{[^}]*opacity:\s*1/s)
  })

  it('keeps a settled tail Tool visually active until the next Turn node appears', () => {
    function ToolFixture() {
      return <span>settled tool waiting for model</span>
    }
    const Wrapped = wrapFollowNodeView(ToolFixture)
    const turn = {
      turn: 9,
      status: 'open',
      start: { time: 1_000 },
    }
    const toolNode = {
      key: 'tool-tail-9',
      kind: 'tool-call',
      anchorSeq: 20,
      visibility: 'visible',
      location: { kind: 'step', turn, step: { step: 1 } },
      data: { root: { kind: 'tool-result', callId: 'call-9', name: 'smops_knowledge_search' } },
    }
    const nextNode = {
      key: 'assistant-next-9',
      kind: 'assistant-step',
      anchorSeq: 21,
      visibility: 'visible',
      location: { kind: 'step', turn, step: { step: 2 } },
      data: { status: 'running', blocks: [{ kind: 'reasoning', text: 'next thought' }] },
    }
    let nodes = new Map<string, unknown>([[toolNode.key, toolNode]])
    let order = [toolNode.key]
    let running = true
    const useSession = (selector: (snapshot: unknown) => unknown) => selector({
      running,
      chat: {
        order,
        nodes: { get: (key: string) => nodes.get(key) },
        timeline: { turns: new Map([[9, turn]]) },
      },
    })
    const props = {
      sessionId: 'tool-tail-session',
      node: toolNode,
      useSession,
    }
    const view = render(<Wrapped {...props} />)
    const tool = view.container.querySelector('[data-stream-node="tool-call"]')

    expect(tool?.getAttribute('data-stream-state')).toBe('settled')
    expect(tool?.getAttribute('data-stream-progress')).toBe('active')

    nodes = new Map<string, unknown>([[toolNode.key, toolNode], [nextNode.key, nextNode]])
    order = [toolNode.key, nextNode.key]
    view.rerender(<Wrapped {...props} />)
    expect(view.container.querySelector('[data-stream-node="tool-call"]')?.hasAttribute('data-stream-progress')).toBe(false)

    nodes = new Map<string, unknown>([[toolNode.key, toolNode]])
    order = [toolNode.key]
    running = false
    view.rerender(<Wrapped {...props} />)
    expect(view.container.querySelector('[data-stream-node="tool-call"]')?.hasAttribute('data-stream-progress')).toBe(false)

    const styleSheet = readFileSync('src/client/TypewriterAssistantNodeView.module.css', 'utf8')
    expect(styleSheet).toMatch(/data-stream-tool-row[^}]*data-stream-progress='active'[\s\S]*::after\s*{/s)
  })

  it('folds a settled Tool row with the successful final answer from the same Turn', () => {
    function ToolFixture() {
      return <span>tool process</span>
    }
    const Wrapped = wrapFollowNodeView(ToolFixture)
    const turn = {
      turn: 3,
      status: 'closed',
      start: { time: 1_000 },
      end: { time: 4_000, data: { reason: { kind: 'completed' } } },
    }
    const view = render(<>
      <Wrapped
        sessionId="tool-session"
        node={{
          key: 'tool-3',
          kind: 'tool-call',
          location: { kind: 'step', turn, step: { step: 1 } },
          data: { root: { kind: 'tool-result', callId: 'call-3', name: 'read_file' } },
        }}
      />
      <TypewriterAssistantNodeView {...assistantProps('settled', [
        { kind: 'text', text: 'tool final answer' },
      ], {
        closing: true,
        completed: true,
        nodeKey: 'tool-final-3',
        sessionId: 'tool-session',
        turnNumber: 3,
      })} />
    </>)

    const tool = view.getByText('tool process').closest('[data-stream-node]') as HTMLElement
    const toggle = view.getByRole('button', { name: /耗时/ })
    expect(tool.hidden).toBe(true)
    expect(toggle.getAttribute('aria-controls')).toContain(tool.id)
    fireEvent.click(toggle)
    expect(tool.hidden).toBe(false)
  })
})

describe('computeFollowStep', () => {
  it('eases a wrap-sized lag instead of snapping it', () => {
    const step = computeFollowStep(16, { lag: 28, speedEma: FOLLOW_SPEED_REF_CPS })
    expect(step.advancePx).toBeGreaterThan(0.5)
    expect(step.advancePx).toBeLessThan(28)
    expect(step.lerpStep).toBeLessThan(FOLLOW_LERP_MAX)
  })

  it('accelerates when reveal speed or lag is high', () => {
    const slow = computeFollowStep(16, { lag: 28, speedEma: 20 })
    const fast = computeFollowStep(16, { lag: 200, speedEma: 120 })
    expect(fast.advancePx).toBeGreaterThan(slow.advancePx)
    expect(fast.lerpStep).toBeGreaterThan(slow.lerpStep)
  })

  it('honours the configured scroll-speed ceiling', () => {
    const step = computeFollowStep(16, {
      lag: 1000,
      speedEma: 240,
      minSpeedPxPerSec: 48,
      maxSpeedPxPerSec: 100,
    })
    expect(step.advancePx).toBeLessThanOrEqual(1.6)
  })

  it('settles when lag is already closed', () => {
    const step = computeFollowStep(16, { lag: 0, speedEma: 80 })
    expect(step.advancePx).toBe(0)
    expect(step.lerpStep).toBe(0)
  })

  it('uses the demo dt term', () => {
    const step = computeFollowStep(FOLLOW_LERP_DT_MS, { lag: 160, speedEma: FOLLOW_SPEED_REF_CPS })
    // lag == LAG_REF and speedFactor == 1 → baseLerp saturates at MAX; dt term is 1 - 1/e.
    expect(step.lerpStep).toBeCloseTo(FOLLOW_LERP_MAX * (1 - Math.exp(-1)), 5)
  })

  it('closes a line-sized lag over many frames instead of one hop', () => {
    let lag = 28
    for (let frame = 0; frame < 10; frame += 1) {
      const step = computeFollowStep(16, { lag, speedEma: FOLLOW_SPEED_REF_CPS })
      expect(step.advancePx).toBeLessThan(8)
      lag -= step.advancePx
    }
    expect(lag).toBeGreaterThan(8)
    expect(lag).toBeLessThan(24)
  })
})
