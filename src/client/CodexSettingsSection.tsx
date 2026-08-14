/** Native Settings section for the external Codex provider plugin. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, StateDot, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CodexAuthFailureReason,
  CodexAuthState,
  CodexLoginMethod,
  CodexUsageWindow,
} from '../types.ts'
import type { CodexAuthCardFace, CodexAuthCardState } from './controller.ts'
import type { CodexSettingsKey } from './locales.ts'
import { OpenAILogo } from './OpenAILogo.tsx'
import css from './CodexSettingsSection.module.css'

/** Props bound by the Settings section slot. */
export type CodexSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.codexProvider'>
  & InjectFace<CodexAuthCardFace>

function assertNever(value: never): never {
  throw new Error(`unhandled Codex auth state: ${JSON.stringify(value)}`)
}

/** Whether an auth phase owns a login still in progress. */
export function isLoginActive(state: CodexAuthState): boolean {
  switch (state.phase) {
    case 'starting':
    case 'awaiting-browser':
    case 'awaiting-device': return true
    case 'connected':
    case 'disconnected':
    case 'failed': return false
    default: return assertNever(state)
  }
}

/** Resolve the state-dot semantic for one auth phase. */
export function authDot(state: CodexAuthState): StateDotState {
  switch (state.phase) {
    case 'connected': return 'done'
    case 'starting':
    case 'awaiting-browser':
    case 'awaiting-device': return 'ongoing'
    case 'failed': return 'error'
    case 'disconnected': return 'warning'
    default: return assertNever(state)
  }
}

/** Resolve the localized status key for one auth phase. */
export function authLabel(state: CodexAuthState): CodexSettingsKey {
  switch (state.phase) {
    case 'connected': return 'connected'
    case 'starting': return 'starting'
    case 'awaiting-browser': return 'awaitingBrowser'
    case 'awaiting-device': return 'awaitingDevice'
    case 'failed': return 'failed'
    case 'disconnected': return 'disconnected'
    default: return assertNever(state)
  }
}

/** Resolve actionable UI copy for one secret-free Host failure reason. */
export function authFailureLabel(reason: CodexAuthFailureReason): CodexSettingsKey {
  switch (reason) {
    case 'account-access': return 'failureAccountAccess'
    case 'browser-callback': return 'failureBrowserCallback'
    case 'device-code-disabled': return 'failureDeviceCodeDisabled'
    case 'network': return 'failureNetwork'
    case 'token-exchange': return 'failureTokenExchange'
    case 'unsupported-region': return 'failureUnsupportedRegion'
    case 'unknown': return 'failureUnknown'
    default: return assertNever(reason)
  }
}

function diagnosticCode(reason: CodexAuthFailureReason): string {
  return `CODEX_AUTH_${reason.replaceAll('-', '_').toUpperCase()}`
}

function useCopyCode(code: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => { window.clearTimeout(timer.current) }, [])
  const copy = useCallback(() => {
    void writeClipboard(code).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [code])
  return { copied, copy }
}

function LoginBody({ state, t }: { state: CodexAuthState; t: (key: CodexSettingsKey) => string }): ReactNode {
  const code = state.phase === 'awaiting-device' ? state.userCode : ''
  const copy = useCopyCode(code)
  if (state.phase === 'awaiting-browser') {
    return (
      <div className={css.loginBody}>
        <p>{t('browserWaiting')}</p>
        <a className={css.externalLink} href={state.authorizationUrl} target="_blank" rel="noreferrer">
          {t('openLoginPage')}
        </a>
      </div>
    )
  }
  if (state.phase === 'awaiting-device') {
    return (
      <div className={css.loginBody}>
        <p>{t('deviceWaiting')}</p>
        <div className={css.deviceCodeRow}>
          <code className={css.deviceCode}>{state.userCode}</code>
          <Button size="sm" variant="outline" onClick={copy.copy}>
            {t(copy.copied ? 'copied' : 'copyCode')}
          </Button>
        </div>
        <a className={css.externalLink} href={state.verificationUri} target="_blank" rel="noreferrer">
          {t('openVerificationPage')}
        </a>
      </div>
    )
  }
  if (state.phase === 'starting') return <p className={css.waiting}>{t('starting')}</p>
  if (state.phase === 'failed') {
    return (
      <div className={css.loginFailure} role="status">
        <p className={css.error}>{t(authFailureLabel(state.reason))}</p>
        <code className={css.diagnosticCode}>{diagnosticCode(state.reason)}</code>
      </div>
    )
  }
  return null
}

type Translate = (key: CodexSettingsKey) => string

function formatWindowDuration(seconds: number | null): string | null {
  if (seconds === null) return null
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  return `${Math.max(1, Math.round(seconds / 60))}m`
}

function formatResetTime(timestamp: number | null): string | null {
  if (timestamp === null) return null
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function usageWindowTitle(window: CodexUsageWindow, fallback: CodexSettingsKey, t: Translate): string {
  const duration = formatWindowDuration(window.limitWindowSeconds)
  return duration === null ? t(fallback) : `${duration} ${t('usageWindow')}`
}

function UsageWindowRow({
  window,
  fallback,
  t,
}: {
  window: CodexUsageWindow
  fallback: CodexSettingsKey
  t: Translate
}): ReactNode {
  const title = usageWindowTitle(window, fallback, t)
  const reset = formatResetTime(window.resetAt)
  return (
    <div className={css.usageWindow}>
      <div className={css.usageWindowHead}>
        <span className={css.usageWindowTitle}>{title}</span>
        <span className={css.usagePercent}>{Math.round(window.usedPercent)}%</span>
      </div>
      <progress
        className={css.usageProgress}
        max={100}
        value={window.usedPercent}
        aria-label={`${title}: ${t('usedLabel')} ${Math.round(window.usedPercent)}%`}
      />
      <div className={css.usageWindowMeta}>
        <span>{t('usedLabel')} {Math.round(window.usedPercent)}%</span>
        {reset === null ? null : <span>{t('resetsLabel')} <time dateTime={new Date(window.resetAt ?? 0).toISOString()}>{reset}</time></span>}
      </div>
    </div>
  )
}

function UsagePanel({
  state,
  t,
  refresh,
}: {
  state: CodexAuthCardState
  t: Translate
  refresh: () => void
}): ReactNode {
  const usage = state.usage
  const credits = usage?.credits
  const creditLabel = credits?.unlimited === true
    ? t('unlimitedCredits')
    : credits?.hasCredits === true && credits.balance !== null
      ? credits.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : null
  return (
    <div className={css.usagePanel}>
      <div className={css.usageHead}>
        <h3 className={css.usageTitle}>{t('usageTitle')}</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={state.usageStatus === 'loading'}
          onClick={refresh}
        >
          {t('refreshUsage')}
        </Button>
      </div>
      {state.usageStatus === 'loading' && usage === null
        ? <p className={css.usageMessage}>{t('usageLoading')}</p>
        : null}
      {usage === null && state.usageStatus === 'error'
        ? <p className={css.error} role="status">{t('usageUnavailable')}</p>
        : null}
      {usage === null
        ? null
        : (
          <>
            {usage.planType === null && creditLabel === null
              ? null
              : (
                <dl className={css.usageFacts}>
                  {usage.planType === null
                    ? null
                    : <><dt>{t('planLabel')}</dt><dd>{usage.planType}</dd></>}
                  {creditLabel === null
                    ? null
                    : <><dt>{t('creditsLabel')}</dt><dd>{creditLabel}</dd></>}
                </dl>
              )}
            {usage.limitReached ? <p className={css.usageLimit} role="status">{t('limitReached')}</p> : null}
            {usage.primary === null && usage.secondary === null
              ? null
              : (
                <div className={css.usageGrid}>
                  {usage.primary === null
                    ? null
                    : <UsageWindowRow window={usage.primary} fallback="primaryWindow" t={t} />}
                  {usage.secondary === null
                    ? null
                    : <UsageWindowRow window={usage.secondary} fallback="secondaryWindow" t={t} />}
                </div>
              )}
            {state.usageStatus === 'error'
              ? <p className={css.error} role="status">{t('usageUnavailable')}</p>
              : null}
          </>
        )}
    </div>
  )
}

/** Render the external provider's independent Settings section. */
export function CodexSettingsSection(props: CodexSettingsSectionProps): ReactNode {
  const { t } = props
  const state = props.useCodexAuth(snapshot => snapshot)
  const [loginOpen, setLoginOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const active = isLoginActive(state.auth)
  const closeState = useRef({ action: state.action, active })
  closeState.current = { action: state.action, active }

  useEffect(() => { props.load() }, [props.load])
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(props.refresh, 600)
    return () => { window.clearInterval(timer) }
  }, [active, props.refresh])
  useEffect(() => {
    if (state.auth.phase !== 'connected') return
    setLoginOpen(false)
    const timer = window.setInterval(props.refresh, 60_000)
    return () => { window.clearInterval(timer) }
  }, [props.refresh, state.auth.phase])

  const closeLogin = (): void => {
    if (closeState.current.action === 'login') return
    if (closeState.current.active) props.cancel()
    setLoginOpen(false)
  }
  const start = (method: CodexLoginMethod): void => {
    setLoginOpen(true)
    props.login(method)
  }

  const loginFooter = active
    ? (
      <Button variant="outline" disabled={state.action === 'cancel'} onClick={closeLogin}>
        {t('cancelLogin')}
      </Button>
    )
    : (
      <>
        <Button variant="outline" onClick={closeLogin}>{t('cancel')}</Button>
        <Button variant="outline" disabled={state.action !== null} onClick={() => { start('device') }}>
          {t('deviceLogin')}
        </Button>
        <Button variant="primary" disabled={state.action !== null} onClick={() => { start('browser') }}>
          {t('browserLogin')}
        </Button>
      </>
    )

  return (
    <section className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('description')}</p>
      <div className={css.card}>
        <div className={css.cardHead}>
          <div className={css.identity}>
            <div className={css.providerLine}>
              <OpenAILogo className={css.providerIcon} />
              <span className={css.providerName}>{t('title')}</span>
            </div>
            <span className={css.status} role="status">
              <StateDot state={authDot(state.auth)} />
              {state.status === 'loading' || state.status === 'idle' ? t('loading') : t(authLabel(state.auth))}
            </span>
          </div>
          {state.status === 'error'
            ? <Button size="sm" variant="outline" onClick={props.load}>{t('retry')}</Button>
            : state.auth.phase === 'connected'
              ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.action !== null || !props.isLoopback}
                  onClick={() => { setLogoutOpen(true) }}
                >
                  {t('disconnect')}
                </Button>
              )
              : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!props.isLoopback || state.status === 'loading' || state.action !== null || active}
                  onClick={() => { setLoginOpen(true) }}
                >
                  {t(state.auth.phase === 'failed' ? 'retry' : 'connect')}
                </Button>
              )}
        </div>
        <p className={css.contextInfo}>{t('contextInfo')}</p>
        {!props.isLoopback ? <p className={css.error} role="status">{t('remoteHint')}</p> : null}
        {state.status === 'error' ? <p className={css.error} role="status">{t('loadFailed')}</p> : null}
        {state.actionFailed ? <p className={css.error} role="status">{t('actionFailed')}</p> : null}
      </div>

      {state.auth.phase === 'connected'
        ? <UsagePanel state={state} t={t} refresh={props.load} />
        : null}

      <Modal
        open={props.isLoopback && (loginOpen || active || state.action === 'login') && state.auth.phase !== 'connected'}
        onClose={closeLogin}
        title={t('connectTitle')}
        closeLabel={t('close')}
        description={t('connectDescription')}
        footer={loginFooter}
      >
        <p className={css.hint}>{t('localHint')}</p>
        <LoginBody state={state.auth} t={t} />
      </Modal>

      <Modal
        open={logoutOpen}
        onClose={() => { if (state.action !== 'logout') setLogoutOpen(false) }}
        title={t('disconnectTitle')}
        closeLabel={t('close')}
        description={t('disconnectDescription')}
        footer={(
          <>
            <Button variant="outline" disabled={state.action === 'logout'} onClick={() => { setLogoutOpen(false) }}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={state.action === 'logout'}
              onClick={() => {
                props.logout()
                setLogoutOpen(false)
              }}
            >
              {t(state.action === 'logout' ? 'disconnecting' : 'confirmDisconnect')}
            </Button>
          </>
        )}
      />
    </section>
  )
}
