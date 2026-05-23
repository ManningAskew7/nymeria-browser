import { useEffect, useMemo, useState } from 'react'
import { popupLogger as logger } from '../utils/logger'
import { BROADCAST_CHANNEL, type PopupRequest, type PopupResponse, type SnapshotBroadcast } from '../shared/messages'
import type { BackgroundSnapshot, ConnectionStatus } from '../shared/types'

const DEFAULT_BASE_URL = 'http://localhost:8000'

async function send(request: PopupRequest): Promise<PopupResponse> {
  return (await chrome.runtime.sendMessage(request)) as PopupResponse
}

function relTime(target: number, now: number): string {
  const diff = Math.max(0, target - now)
  const s = Math.round(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function StatusCard({ status, now }: { status: ConnectionStatus; now: number }) {
  switch (status.kind) {
    case 'unconfigured':
      return null
    case 'connecting':
      return (
        <div className="status-card connecting">
          <div className="status-row">
            <span><span className="dot blue" />Connecting…</span>
            <span className="status-value">{Math.round((now - status.since) / 1000)}s</span>
          </div>
        </div>
      )
    case 'connected':
      return (
        <div className="status-card connected">
          <div className="status-row">
            <span><span className="dot green" />Connected</span>
            <span className="status-value">since {new Date(status.since).toLocaleTimeString()}</span>
          </div>
          <div className="status-row">
            <span className="status-label">Identity</span>
            <span className="status-value">{status.identity.display_name || status.identity.email}</span>
          </div>
          <div className="status-row">
            <span className="status-label">Email</span>
            <span className="status-value">{status.identity.email}</span>
          </div>
          <div className="status-row">
            <span className="status-label">Role</span>
            <span className={`role-badge ${status.identity.role === 'admin' ? '' : 'user'}`}>
              {status.identity.role}
            </span>
          </div>
        </div>
      )
    case 'disconnected':
      return (
        <div className="status-card disconnected">
          <div className="status-row">
            <span><span className="dot amber" />Reconnecting</span>
            <span className="status-value">in {relTime(status.nextRetryAt, now)}</span>
          </div>
          <div className="status-row">
            <span className="status-label">Reason</span>
            <span className="status-value">{status.reason}</span>
          </div>
          <div className="status-row">
            <span className="status-label">Attempt</span>
            <span className="status-value">#{status.attempt}</span>
          </div>
        </div>
      )
  }
}

export function Popup() {
  const [snapshot, setSnapshot] = useState<BackgroundSnapshot | null>(null)
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let mounted = true
    void send({ kind: 'get-snapshot' }).then((resp) => {
      if (!mounted || !resp.ok || !('snapshot' in resp)) return
      setSnapshot(resp.snapshot)
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    function onMessage(raw: unknown): void {
      const msg = raw as Partial<SnapshotBroadcast>
      if (msg.channel === BROADCAST_CHANNEL && msg.snapshot) {
        setSnapshot(msg.snapshot)
      }
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])

  const isConfigured = snapshot && snapshot.status.kind !== 'unconfigured'

  const lastEventText = useMemo(() => {
    if (!snapshot?.lastEvent) return null
    const { event, receivedAt } = snapshot.lastEvent
    const type = event.type ?? '(unknown)'
    const thread = event.thread_id ?? '—'
    const age = Math.round((now - receivedAt) / 1000)
    return `${type}\nthread: ${thread}\nage: ${age}s`
  }, [snapshot, now])

  async function onConnect() {
    setError(null)
    setBusy(true)
    try {
      const origin = new URL(baseUrl).origin + '/*'
      const granted = await chrome.permissions.request({ origins: [origin] })
      if (!granted) {
        setError('Browser permission for that origin was denied.')
        setBusy(false)
        return
      }
      const resp = await send({ kind: 'connect', baseUrl, token })
      if (!resp.ok) {
        setError(resp.error)
      } else {
        setToken('')
      }
    } catch (err) {
      logger.error(err)
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function onDisconnect() {
    setBusy(true)
    await send({ kind: 'disconnect' })
    setBusy(false)
  }

  async function onForget() {
    setBusy(true)
    await send({ kind: 'forget' })
    setBusy(false)
  }

  return (
    <div className="container">
      <div className="header">
        <h1>Nymeria Browser</h1>
        <div className="version">v0.2.0 · Phase 2 (chrome_* tools)</div>
      </div>
      <div className="body">
        <StatusCard status={snapshot?.status ?? { kind: 'unconfigured' }} now={now} />

        {!isConfigured && (
          <>
            <div className="field">
              <label htmlFor="baseUrl">Nymeria API base URL</label>
              <input
                id="baseUrl"
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:8000"
              />
              <div className="hint">No trailing slash. Use http(s)://host[:port].</div>
            </div>
            <div className="field">
              <label htmlFor="token">Auth token</label>
              <input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="nym_…"
              />
              <div className="hint">
                Mint one with <code>POST /me/tokens</code>, or from the desktop app's Account settings.
              </div>
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="btn-row">
              <button className="btn btn-primary" onClick={onConnect} disabled={busy || !token}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </>
        )}

        {isConfigured && (
          <>
            <div className="field">
              <label>Events received</label>
              <div className="status-value" style={{ textAlign: 'left' }}>{snapshot?.eventCount ?? 0}</div>
            </div>
            <div className="field">
              <label>Commands executed</label>
              <div className="status-value" style={{ textAlign: 'left' }}>
                {snapshot?.commandCount ?? 0}
                {snapshot?.lastCommandType ? ` (last: ${snapshot.lastCommandType})` : ''}
              </div>
            </div>
            {snapshot && snapshot.debuggerTabs.length > 0 && (
              <div className="alert" style={{ background: 'rgba(250, 175, 50, 0.15)', color: '#caa040' }}>
                <span className="dot amber" /> Chrome debugger active on
                {' tab'}{snapshot.debuggerTabs.length === 1 ? '' : 's'}{' '}
                {snapshot.debuggerTabs.join(', ')}
              </div>
            )}
            <div className="field">
              <label>Last event</label>
              {lastEventText ? (
                <pre className="event-preview">{lastEventText}</pre>
              ) : (
                <div className="muted">none yet</div>
              )}
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="btn-row">
              <button className="btn btn-secondary" onClick={onDisconnect} disabled={busy}>
                Disconnect
              </button>
              <button className="btn btn-secondary" onClick={onForget} disabled={busy}>
                Forget token
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
