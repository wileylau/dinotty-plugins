// OpenCode Go usage for Dinotty.
//
// Plan percentages come from the official API:
//   GET https://opencode.ai/zen/go/v1/usage   (Authorization: Bearer <key>)
//   { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
//
// The current session cost comes from opencode's own local service:
//   ~/.local/state/opencode/service.json -> url/password
//   GET <url>/api/event (SSE) -> session.viewed / session.usage.updated
// The renderer consumes the event stream directly (opencode reflects CORS for
// loopback and Tauri origins), so no native helper stays alive while it runs.
// GET <url>/api/session seeds the session list and is the fallback when SSE is
// unavailable (for example a LAN web-UI origin that is not CORS-allowed).
//
// The usage endpoint answers CORS preflights with 404, so a renderer fetch is
// blocked. Requests therefore run in the bundled bin/ helper (curl) with the
// key in the environment, never in argv. That is why this plugin asks for
// `native.execute` and `workspace.read`.

const KEY_STORAGE = 'apiKey'
const PLAN_STORAGE = 'plan'
const INTERVAL_STORAGE = 'refreshSeconds'
const COMPACT_STORAGE = 'compact'
const LIVE_STORAGE = 'liveSession'

const SSE_RECONNECT_MIN_MS = 2000
const SSE_RECONNECT_MAX_MS = 30000
const SESSION_RECONCILE_MS = 5 * 60 * 1000

const PLANS = {
  go: { label: 'Go', rolling: 12, weekly: 30, monthly: 60 },
  plus: { label: 'Go Plus', rolling: 48, weekly: 120, monthly: 240 },
}

export async function activate(ctx) {
  const h = ctx.h

  const usage = ctx.ref(null)
  const session = ctx.ref(null)
  const error = ctx.ref(null)
  const loading = ctx.ref(false)
  const importing = ctx.ref(false)
  const hasKey = ctx.ref(false)
  const plan = ctx.ref('go')
  const intervalSec = ctx.ref(60)
  const compact = ctx.ref(false)
  const live = ctx.ref(true)
  const updatedAt = ctx.ref(0)
  const keyInput = ctx.ref('')
  const locale = ctx.ref(ctx.i18n.getLocale())

  let timer = null
  let disposed = false
  let refreshInFlight = false

  const sessions = new Map()
  let activeSessionId = null
  let eventAbort = null
  let sseConnected = false
  let eventsRunning = false
  let reconcileTimer = null

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const pageHidden = () =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden'

  const localeSub = ctx.i18n.onDidChangeLocale((next) => {
    locale.value = next
  })

  const zh = () => /^zh/i.test(String(locale.value))
  const L = (en, cn) => (zh() ? cn : en)

  function pct(window) {
    const value = Number(window?.percent)
    return Number.isFinite(value) ? value : null
  }

  function fmtPct(window) {
    const value = pct(window)
    return value === null ? '—' : String(Math.round(value))
  }

  function money(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
    const n = Number(value)
    if (n === 0) return '$0'
    if (n < 0.01) return '<$0.01'
    return `$${n.toFixed(2)}`
  }

  // A free model (or a session with no billing metadata) reports cost 0. That is
  // not a price worth showing: the status bar only renders a cost segment for a
  // positive value, and the popover row shows `—`.
  function sessionCost(value) {
    const n = Number(value?.cost)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  function countdown(iso) {
    const at = Date.parse(iso || '')
    if (!Number.isFinite(at)) return '—'
    const ms = at - Date.now()
    if (ms <= 0) return L('now', '现在')
    const minutes = Math.round(ms / 60000)
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor((minutes % 1440) / 60)
    const mins = minutes % 60
    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${mins}m`
    return `${mins}m`
  }

  function truncate(text, max) {
    const value = String(text || '')
    return value.length > max ? `${value.slice(0, max - 1)}…` : value
  }

  async function runBin(args, env) {
    const result = await ctx.exec.run(args, { env, timeout: 20000 })
    if (result.code === 0) return result.stdout
    let message = String(result.stdout || '').trim()
    try {
      const parsed = JSON.parse(message)
      message = parsed?.error?.message || parsed?.message || message
    } catch {
      /* not JSON */
    }
    if (!message) message = String(result.stderr || '').trim()
    throw new Error(message || `helper exited with code ${result.code}`)
  }

  function toSession(entry) {
    return {
      id: entry.id,
      title: entry.title || entry.id || '',
      directory: entry.location?.directory || '',
      cost: Number(entry.cost) || 0,
      updated: Number(entry.time?.updated) || 0,
      viewed: Number(entry.time?.viewed) || 0,
      lastUsageAt: 0,
    }
  }

  // The viewed session wins; otherwise the most recently viewed/updated one.
  // This keeps the status bar on the tab the user is actually looking at.
  function pickSession() {
    if (activeSessionId) {
      const active = sessions.get(activeSessionId)
      if (active) return active
    }
    let best = null
    for (const entry of sessions.values()) {
      if (
        !best ||
        entry.viewed > best.viewed ||
        (entry.viewed === best.viewed && entry.updated > best.updated)
      ) {
        best = entry
      }
    }
    return best
  }

  function syncSession() {
    const picked = pickSession()
    session.value = picked
      ? {
          cost: picked.cost,
          title: picked.title,
          updated: picked.updated,
        }
      : null
  }

  // opencode's TUI writes `OC | <session title>` (truncated to 40 chars) to the
  // terminal title on every tab switch. `session.viewed` alone is not enough:
  // opencode only emits it when a view clears an unread idle transition, so
  // switching between already-read tabs produces no event. The host already
  // tracks the OSC title, so the active pane's title is the reliable "which tab
  // is visible" signal.
  const TITLE_PREFIX = 'OC | '
  const TITLE_POLL_MS = 1000
  let titleTimer = null
  let lastTitle = ''
  let titleRefreshAt = 0

  function normPath(path) {
    return String(path || '')
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase()
  }

  function activePaneTitle() {
    const terminal = ctx.terminal
    if (!terminal) return ''
    try {
      const panes = terminal.listPanes() || []
      const active =
        panes.find((pane) => pane.active) ||
        panes.find((pane) => pane.id === terminal.activePaneId())
      return active?.title || ''
    } catch {
      return ''
    }
  }

  // Prefer a session in the active pane's directory: titles are truncated, so a
  // prefix can match more than one session across projects.
  function sessionForTitle(title) {
    if (!title.startsWith(TITLE_PREFIX)) return null
    const shown = title.slice(TITLE_PREFIX.length).trim()
    if (!shown) return null
    const truncated = shown.endsWith('…')
    const needle = truncated ? shown.slice(0, -1) : shown
    let cwd = ''
    try {
      cwd = normPath(ctx.terminal?.activeCwd())
    } catch {
      cwd = ''
    }
    let best = null
    let bestInCwd = null
    for (const entry of sessions.values()) {
      const entryTitle = String(entry.title || '')
      const hit = truncated ? entryTitle.startsWith(needle) : entryTitle === shown
      if (!hit) continue
      if (cwd && normPath(entry.directory) === cwd) {
        if (!bestInCwd || entry.updated > bestInCwd.updated) bestInCwd = entry
      }
      if (!best || entry.updated > best.updated) best = entry
    }
    return bestInCwd || best
  }

  function syncActiveSessionFromTitle() {
    if (disposed) return
    const title = activePaneTitle()
    if (!title || title === lastTitle) return
    lastTitle = title
    const match = sessionForTitle(title)
    if (match) {
      if (match.id !== activeSessionId) {
        activeSessionId = match.id
        syncSession()
      }
      return
    }
    // A title we cannot resolve means the seed is stale or the session is new.
    // Refetch at most every few seconds instead of on every title flap.
    if (title.startsWith(TITLE_PREFIX) && Date.now() - titleRefreshAt > 5000) {
      titleRefreshAt = Date.now()
      void refreshSession()
    }
  }

  async function readService() {
    const file = await ctx.workspace.readFile('~/.local/state/opencode/service.json')
    if (!file?.content) return null
    const service = JSON.parse(file.content)
    return service?.url ? service : null
  }

  function applySessionList(list) {
    const next = new Map()
    for (const entry of list) {
      if (!entry?.id) continue
      const fresh = toSession(entry)
      const known = sessions.get(entry.id)
      if (known) {
        // An event may be newer than the list snapshot; never roll it back.
        fresh.viewed = Math.max(fresh.viewed, known.viewed)
        if (known.updated > fresh.updated) {
          fresh.cost = known.cost
          fresh.title = known.title || fresh.title
          fresh.directory = fresh.directory || known.directory
          fresh.updated = known.updated
          fresh.lastUsageAt = known.lastUsageAt
        }
      }
      next.set(entry.id, fresh)
    }
    sessions.clear()
    for (const [id, value] of next) {
      sessions.set(id, value)
    }
    if (!activeSessionId || !sessions.has(activeSessionId)) {
      activeSessionId = pickSession()?.id || null
    }
    syncSession()
  }

  // Best-effort: opencode may not be installed or running. A missing local API
  // only hides the session row; it is not a plan-usage error.
  async function refreshSession() {
    try {
      const service = await readService()
      if (!service) {
        sessions.clear()
        activeSessionId = null
        session.value = null
        return
      }
      const out = await runBin(['sessions'], {
        OPENCODE_URL: service.url,
        OPENCODE_PASS: service.password || '',
      })
      const list = JSON.parse(out)?.data
      if (!Array.isArray(list) || list.length === 0) {
        sessions.clear()
        activeSessionId = null
        session.value = null
        return
      }
      applySessionList(list)
    } catch {
      // While the event stream is up the cached map is still current; without
      // it, an unreachable service means the cost is no longer known.
      if (!sseConnected) session.value = null
    }
  }

  function handleEvent(event) {
    const type = event?.type
    const data = event?.data || {}
    const id = data.sessionID
    if (!type || !id) return
    if (type === 'session.viewed') {
      activeSessionId = id
      const known = sessions.get(id)
      if (known) {
        known.viewed = Number(event.created) || known.viewed
        syncSession()
      } else {
        // Viewed a session that was not in the seed (or is new): one local
        // request fills in its title and cost.
        void refreshSession()
      }
      return
    }
    if (type === 'session.usage.updated') {
      const known = sessions.get(id) || toSession({ id, title: id })
      known.cost = Number(data.cost) || 0
      known.updated = Number(event.created) || known.updated
      known.lastUsageAt = Date.now()
      sessions.set(id, known)
      if (!activeSessionId) activeSessionId = id
      if (id === activeSessionId) syncSession()
      return
    }
    if (type === 'session.created') {
      const known = sessions.get(id) || toSession({ id, title: data.title })
      if (data.title) known.title = data.title
      sessions.set(id, known)
      return
    }
    if (type === 'session.renamed') {
      const known = sessions.get(id)
      if (!known) return
      known.title = data.title || known.title
      if (id === activeSessionId) syncSession()
      return
    }
    if (type === 'session.deleted' || type === 'session.archived') {
      sessions.delete(id)
      if (id === activeSessionId) {
        activeSessionId = null
        syncSession()
      }
      return
    }
    if (type === 'session.idle') {
      // Completion fallback for versions that do not emit usage.updated, but
      // never more than one refetch every few seconds.
      const known = sessions.get(id)
      if (id === activeSessionId && (!known || Date.now() - known.lastUsageAt > 5000)) {
        void refreshSession()
      }
    }
  }

  async function pumpEvents(body) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let dataLines = []
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const nl = buffer.indexOf('\n')
          if (nl < 0) break
          let line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (line === '') {
            if (dataLines.length > 0) {
              const payload = dataLines.join('\n')
              dataLines = []
              try {
                handleEvent(JSON.parse(payload))
              } catch {
                /* ignore malformed frame */
              }
            }
            continue
          }
          if (line.startsWith(':')) continue
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  function stopEvents() {
    sseConnected = false
    if (eventAbort) {
      try {
        eventAbort.abort()
      } catch {
        /* already aborted */
      }
      eventAbort = null
    }
  }

  // The opencode server reflects CORS for loopback/Tauri origins and handles
  // the authorization preflight, so the event stream can run in the renderer.
  // That avoids a long-lived native helper (which would also hold the plugin
  // operation lock while the stream is open).
  async function runEvents() {
    if (typeof fetch !== 'function' || eventsRunning) return
    eventsRunning = true
    let backoff = SSE_RECONNECT_MIN_MS
    try {
      while (!disposed) {
        // A hidden page (background browser tab, suspended webview) cannot
        // render the result; drop the stream and reconnect when it is shown.
        if (!live.value || pageHidden()) {
          await sleep(1000)
          continue
        }
        let service = null
        try {
          service = await readService()
        } catch {
          service = null
        }
        if (!service) {
          await sleep(SSE_RECONNECT_MAX_MS)
          continue
        }
        const controller = new AbortController()
        eventAbort = controller
        try {
          const response = await fetch(`${service.url}/api/event`, {
            headers: {
              Authorization: `Basic ${btoa(`opencode:${service.password || ''}`)}`,
              Accept: 'text/event-stream',
            },
            cache: 'no-store',
            signal: controller.signal,
          })
          if (!response.ok || !response.body) {
            throw new Error(`event stream returned ${response.status}`)
          }
          if (disposed || !live.value || pageHidden()) {
            controller.abort()
            continue
          }
          sseConnected = true
          backoff = SSE_RECONNECT_MIN_MS
          if (sessions.size === 0) void refreshSession()
          await pumpEvents(response.body)
        } catch {
          /* aborted, CORS-blocked or opencode restarted; retry with backoff */
        } finally {
          sseConnected = false
          if (eventAbort === controller) eventAbort = null
          controller.abort()
        }
        if (disposed) break
        await sleep(backoff)
        backoff = Math.min(backoff * 2, SSE_RECONNECT_MAX_MS)
      }
    } finally {
      eventsRunning = false
    }
  }

  const onVisibilityChange = () => {
    if (pageHidden()) stopEvents()
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  function payloadSnippet(text) {
    return String(text || '')
      .replace(/oc_sk_[A-Za-z0-9_-]+/g, 'oc_sk_***')
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160)
  }

  function unexpectedPayload(out) {
    const snippet = payloadSnippet(out)
    const err = new Error(
      `${L('The usage API returned an unexpected payload.', '用量接口返回了无法识别的数据。')}${
        snippet ? ` (${snippet})` : ''
      }`
    )
    err.unexpected = true
    return err
  }

  function parseUsage(out) {
    let parsed
    try {
      parsed = JSON.parse(out)
    } catch {
      throw unexpectedPayload(out)
    }
    if (parsed?.error) {
      const message = parsed.error.message || parsed.error
      throw new Error(
        typeof message === 'string'
          ? message
          : L('The usage API returned an error.', '用量接口返回了错误。')
      )
    }
    const windows = parsed?.usage ?? parsed?.data?.usage
    if (!windows || typeof windows !== 'object' || Array.isArray(windows)) {
      throw unexpectedPayload(out)
    }
    const rolling = windows.rolling ?? null
    const weekly = windows.weekly ?? null
    const monthly = windows.monthly ?? null
    if (!rolling && !weekly && !monthly) throw unexpectedPayload(out)
    return { rolling, weekly, monthly }
  }

  async function fetchUsage(key) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const out = await runBin(['usage'], { OPENCODE_GO_KEY: key })
      try {
        return parseUsage(out)
      } catch (err) {
        // One retry: the edge occasionally answers with an empty body or an
        // HTML error page and a 2xx. Auth/network failures are not retried.
        if (!err?.unexpected || attempt > 0) throw err
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
    }
    throw new Error(L('The usage API returned an unexpected payload.', '用量接口返回了无法识别的数据。'))
  }

  async function refresh(forceSession = false) {
    if (disposed || refreshInFlight) return
    const key = await ctx.storage.get(KEY_STORAGE)
    if (!key) {
      hasKey.value = false
      usage.value = null
      session.value = null
      error.value = null
      return
    }
    hasKey.value = true
    refreshInFlight = true
    loading.value = true
    // Session cost is event-driven while the local stream is connected; only
    // poll /api/session when it is not (or when the user asks explicitly).
    if (forceSession || !sseConnected) void refreshSession()
    try {
      const windows = await fetchUsage(key)
      usage.value = {
        rolling: windows.rolling,
        weekly: windows.weekly,
        monthly: windows.monthly,
      }
      error.value = null
      updatedAt.value = Date.now()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      refreshInFlight = false
      loading.value = false
    }
  }

  async function saveKey() {
    const key = keyInput.value.trim()
    if (!key) return
    await ctx.storage.set(KEY_STORAGE, key)
    keyInput.value = ''
    hasKey.value = true
    error.value = null
    await refresh()
  }

  async function clearKey() {
    await ctx.storage.delete(KEY_STORAGE)
    hasKey.value = false
    usage.value = null
    session.value = null
    error.value = null
  }

  async function importKey() {
    if (importing.value) return
    importing.value = true
    try {
      const file = await ctx.workspace.readFile('~/.local/share/opencode/auth.json')
      if (!file?.content) {
        throw new Error(
          L('No opencode auth.json found on this machine.', '此机器上没有找到 opencode 的 auth.json。')
        )
      }
      const auth = JSON.parse(file.content)
      const entry = auth['opencode-go'] || auth.opencode
      const key = entry?.key || entry?.apiKey
      if (!key) {
        throw new Error(
          L(
            'No opencode-go key in auth.json. Connect OpenCode Go in opencode first.',
            'auth.json 里没有 opencode-go 密钥，请先在 opencode 中连接 OpenCode Go。'
          )
        )
      }
      await ctx.storage.set(KEY_STORAGE, key)
      hasKey.value = true
      error.value = null
      await refresh()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      importing.value = false
    }
  }

  function schedule() {
    if (timer) clearInterval(timer)
    const seconds = Math.max(15, Math.min(3600, Number(intervalSec.value) || 60))
    intervalSec.value = seconds
    timer = setInterval(() => {
      void refresh()
    }, seconds * 1000)
  }

  function caps() {
    return PLANS[plan.value] || PLANS.go
  }

  function costEstimate(window, cap) {
    const value = pct(window)
    return value === null ? '—' : money((Math.min(100, value) / 100) * cap)
  }

  function detailRows() {
    const rows = []
    if (!hasKey.value) {
      rows.push({
        label: L('API key', 'API 密钥'),
        value: L('not set — open the plugin tab', '未设置 — 请在插件页配置'),
      })
      return rows
    }
    if (error.value) rows.push({ label: L('Error', '错误'), value: error.value })
    const current = usage.value
    const limits = caps()
    if (current) {
      for (const [key, label, cap] of [
        ['rolling', '5h', limits.rolling],
        ['weekly', '7d', limits.weekly],
        ['monthly', '30d', limits.monthly],
      ]) {
        const window = current[key]
        const limited = window?.status === 'rate-limited'
        rows.push({
          label: `${label} ${L('usage', '用量')}`,
          value: `${fmtPct(window)}%${limited ? L(' (limit)', '（已达上限）') : ''} · ${L('resets', '重置')} ${countdown(window?.resetsAt)}`,
        })
        rows.push({
          label: `${label} ${L('cost', '花费')}`,
          value: `≈ ${costEstimate(window, cap)} / ${money(cap)}`,
        })
      }
    }
    const cost = sessionCost(session.value)
    rows.push({
      label: L('Session cost', '会话花费'),
      value: session.value
        ? `${cost === null ? '—' : money(cost)} · ${truncate(session.value.title, 24)}`
        : '—',
    })
    rows.push({
      label: L('Plan caps', '套餐上限'),
      value: `${limits.label} · ${money(limits.rolling)} / ${money(limits.weekly)} / ${money(limits.monthly)}`,
    })
    if (updatedAt.value) {
      rows.push({
        label: L('Updated', '更新于'),
        value: new Date(updatedAt.value).toLocaleTimeString(),
      })
    }
    return rows
  }

  const series = {
    id: 'opencode-go-usage:plan',
    label: 'OpenCode Go',
    scale: 'percent',
    statusIcon: 'Gauge',
    color: '#f59e0b',
    defaultVisible: true,
    // Plan quotas are a snapshot, not a signal: a line chart of the last minute
    // says nothing. The popover shows the detail rows only.
    showChart: false,
    statusText: () => {
      if (!hasKey.value) return null
      const cost = sessionCost(session.value)
      const suffix = cost === null ? '' : ` | ${money(cost)}`
      const current = usage.value
      if (!current) return `${error.value ? 'Go !' : 'Go …'}${suffix}`
      const rolling = fmtPct(current.rolling)
      const plan = compact.value ? `Go ${rolling}%` : `Go 5h ${rolling}%`
      return `${plan}${suffix}`
    },
    detail: () => detailRows(),
  }

  function renderUsage() {
    const limits = caps()
    const windows = [
      ['rolling', L('5-hour rolling', '5 小时滚动'), limits.rolling],
      ['weekly', L('Weekly', '每周'), limits.weekly],
      ['monthly', L('Monthly', '每月'), limits.monthly],
    ]
    return h('section', { class: 'ogu-card' }, [
      h('div', { class: 'ogu-card-head' }, [
        h('span', null, L('Usage', '用量')),
        h(
          'span',
          { class: 'ogu-muted' },
          updatedAt.value ? new Date(updatedAt.value).toLocaleTimeString() : ''
        ),
      ]),
      ...windows.map(([key, label, cap]) => {
        const window = usage.value?.[key]
        const value = pct(window)
        const shown = value === null ? 0 : Math.min(100, Math.max(0, value))
        const tone = shown >= 90 ? 'ogu-danger' : shown >= 50 ? 'ogu-warn' : ''
        return h('div', { class: 'ogu-window' }, [
          h('div', { class: 'ogu-window-head' }, [
            h('span', null, label),
            h('strong', { class: tone }, `${fmtPct(window)}%`),
          ]),
          h('div', { class: 'ogu-bar' }, [
            h('div', { class: `ogu-bar-fill ${tone}`, style: { width: `${shown}%` } }),
          ]),
          h('div', { class: 'ogu-window-foot' }, [
            h('span', null, `≈ ${costEstimate(window, cap)} / ${money(cap)}`),
            h('span', null, `↻ ${countdown(window?.resetsAt)}`),
          ]),
        ])
      }),
    ])
  }

  const component = {
    render() {
      return h('div', { class: 'ogu' }, [
        h('header', { class: 'ogu-header' }, [
          h('h2', null, L('OpenCode Go usage', 'OpenCode Go 用量')),
          h(
            'span',
            { class: `ogu-pill ${error.value ? 'is-error' : hasKey.value ? 'is-ok' : ''}` },
            loading.value
              ? L('refreshing…', '刷新中…')
              : error.value
                ? L('error', '错误')
                : hasKey.value
                  ? L('connected', '已连接')
                  : L('no key', '未配置')
          ),
        ]),
        h(
          'p',
          { class: 'ogu-sub' },
          L(
            '5-hour rolling, weekly and monthly plan usage, estimated spend, and the current opencode session cost. Session cost follows opencode tab switches and prompt completions live; plan usage is polled. Shown next to the system monitor in the status bar.',
            '5 小时滚动 / 每周 / 每月的套餐用量、估算花费，以及当前 opencode 会话成本。会话成本会随 opencode 的标签切换和提示完成实时更新；套餐用量则定时拉取。会显示在状态栏系统监控旁。'
          )
        ),
        h('section', { class: 'ogu-card' }, [
          h('label', { class: 'ogu-label' }, L('OpenCode Go API key', 'OpenCode Go API 密钥')),
          h('div', { class: 'ogu-row' }, [
            h('input', {
              class: 'ogu-input',
              type: 'password',
              autocomplete: 'off',
              spellcheck: false,
              placeholder: hasKey.value ? '••••••••' : 'sk-…',
              value: keyInput.value,
              onInput: (event) => {
                keyInput.value = event.target.value
              },
              onKeydown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void saveKey()
                }
              },
            }),
            h(
              'button',
              {
                class: 'ogu-btn is-primary',
                disabled: loading.value || !keyInput.value.trim(),
                onClick: () => void saveKey(),
              },
              L('Save', '保存')
            ),
          ]),
          h('div', { class: 'ogu-row wrap' }, [
            h(
              'button',
              { class: 'ogu-btn', disabled: loading.value, onClick: () => void refresh(true) },
              L('Refresh', '刷新')
            ),
            h(
              'button',
              {
                class: 'ogu-btn',
                disabled: loading.value || importing.value,
                onClick: () => void importKey(),
              },
              importing.value
                ? L('importing…', '导入中…')
                : L('Import from opencode', '从 opencode 导入')
            ),
            h(
              'button',
              {
                class: 'ogu-btn is-danger',
                disabled: !hasKey.value,
                onClick: () => void clearKey(),
              },
              L('Remove key', '删除密钥')
            ),
          ]),
          h(
            'p',
            { class: 'ogu-muted' },
            L(
              'The key is stored in Dinotty plugin data on this machine. Requests are made by the bundled helper, not by the browser.',
              '密钥保存在本机的 Dinotty 插件数据目录。请求由插件自带辅助程序发起，不经过浏览器。'
            )
          ),
        ]),
        error.value ? h('p', { class: 'ogu-error' }, error.value) : null,
        usage.value ? renderUsage() : null,
        session.value
          ? h('section', { class: 'ogu-card' }, [
              h('div', { class: 'ogu-card-head' }, [
                h('span', null, L('Current session', '当前会话')),
                h('strong', null, money(session.value.cost)),
              ]),
              h('p', { class: 'ogu-muted' }, session.value.title),
            ])
          : null,
        h('section', { class: 'ogu-card' }, [
          h('div', { class: 'ogu-row wrap' }, [
            h('label', { class: 'ogu-label' }, L('Plan', '套餐')),
            h(
              'select',
              {
                class: 'ogu-select',
                value: plan.value,
                onChange: (event) => {
                  plan.value = event.target.value
                  void ctx.storage.set(PLAN_STORAGE, plan.value)
                },
              },
              [
                h('option', { value: 'go' }, 'Go — $12 / $30 / $60'),
                h('option', { value: 'plus' }, 'Go Plus — $48 / $120 / $240'),
              ]
            ),
            h('label', { class: 'ogu-label' }, L('Plan refresh every', '套餐刷新间隔')),
            h('input', {
              class: 'ogu-input is-small',
              type: 'number',
              min: '15',
              max: '3600',
              value: intervalSec.value,
              onChange: (event) => {
                intervalSec.value = Math.max(15, Math.min(3600, Number(event.target.value) || 60))
                void ctx.storage.set(INTERVAL_STORAGE, intervalSec.value)
                schedule()
              },
            }),
            h('span', { class: 'ogu-muted' }, L('seconds', '秒')),
          ]),
          h('label', { class: 'ogu-check' }, [
            h('input', {
              type: 'checkbox',
              checked: compact.value,
              onChange: (event) => {
                compact.value = event.target.checked
                void ctx.storage.set(COMPACT_STORAGE, compact.value)
              },
            }),
            L('Compact status bar text', '状态栏使用紧凑文本'),
          ]),
          h('label', { class: 'ogu-check' }, [
            h('input', {
              type: 'checkbox',
              checked: live.value,
              onChange: (event) => {
                live.value = event.target.checked
                void ctx.storage.set(LIVE_STORAGE, live.value)
                if (!live.value) {
                  stopEvents()
                  void refreshSession()
                }
              },
            }),
            L(
              'Live session cost (opencode event stream)',
              '实时会话成本（opencode 事件流）'
            ),
          ]),
        ]),
      ])
    },
  }

  // Load persisted settings before returning so the first render is correct.
  // The first network refresh runs in the background; the status bar shows
  // "Go …" until it lands.
  const storedPlan = await ctx.storage.get(PLAN_STORAGE)
  if (storedPlan === 'go' || storedPlan === 'plus') plan.value = storedPlan
  const storedInterval = Number(await ctx.storage.get(INTERVAL_STORAGE))
  if (Number.isFinite(storedInterval) && storedInterval > 0) {
    intervalSec.value = Math.max(15, Math.min(3600, storedInterval))
  }
  compact.value = (await ctx.storage.get(COMPACT_STORAGE)) === true
  live.value = (await ctx.storage.get(LIVE_STORAGE)) !== false
  hasKey.value = Boolean(await ctx.storage.get(KEY_STORAGE))
  schedule()
  if (hasKey.value) void refresh()
  // Seed the session list once; the event stream keeps it current afterwards
  // and a slow reconcile catches anything the stream missed.
  void refreshSession()
  // The title poll covers opencode's own tab switches (no session.viewed) and
  // switching between Dinotty tabs that each host an opencode instance.
  const paneTitleSub = ctx.terminal?.onDidChangeActivePane?.(() => {
    lastTitle = ''
    syncActiveSessionFromTitle()
  })
  titleTimer = setInterval(syncActiveSessionFromTitle, TITLE_POLL_MS)
  syncActiveSessionFromTitle()
  reconcileTimer = setInterval(() => {
    if (!disposed && sseConnected) void refreshSession()
  }, SESSION_RECONCILE_MS)
  void runEvents()

  ctx.commands.register('opencode-go-usage.open', () => ctx.open())
  ctx.commands.register('opencode-go-usage.refresh', () => void refresh(true))

  return {
    component,
    monitor: { series: [series] },
    dispose() {
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
      if (reconcileTimer) clearInterval(reconcileTimer)
      reconcileTimer = null
      if (titleTimer) clearInterval(titleTimer)
      titleTimer = null
      paneTitleSub?.dispose()
      stopEvents()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      localeSub.dispose()
    },
  }
}
