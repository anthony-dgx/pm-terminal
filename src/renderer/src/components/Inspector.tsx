import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentView,
  ContextUsageView,
  McpServerView,
  McpStatus,
  PluginView,
  SkillView,
  UsageView,
} from '../../../shared/types.js'
import { desk } from '../lib/api.js'
import { fmtCost, fmtTokens, type SessionVitals } from '../lib/sessionState.js'
import { CopyButton } from './Copy.js'
import { McpLogin } from './McpLogin.js'
import { ProfilesPanel } from './Profiles.js'
import { UpdateRow } from './UpdateRow.js'

export type Tab = 'mcp' | 'skills' | 'profiles' | 'usage'
/** Agents and plugins are the same question as skills: what got loaded. */
type LoadedView = 'skills' | 'agents' | 'plugins'

/**
 * The buckets that collapse to a single row.
 *
 * Nothing in them needs a decision, so the panel states the count and gets out
 * of the way; the old per-status list is still one click behind the caret.
 */
const QUIET_SECTIONS: { key: McpStatus; label: string; dot: string }[] = [
  { key: 'connected', label: 'connected', dot: 'ix-dot-live' },
  { key: 'pending', label: 'not started', dot: 'dot-idle' },
  { key: 'disabled', label: 'disabled', dot: 'dot-done' },
]

/** How the summary line names each bucket, in the order it reads them. */
const COUNT_LABELS: { key: McpStatus; label: string }[] = [
  { key: 'failed', label: 'failed' },
  { key: 'needs-auth', label: 'need auth' },
  { key: 'connected', label: 'connected' },
  { key: 'pending', label: 'pending' },
  { key: 'disabled', label: 'disabled' },
]

/** The three-color spend split, in the order the handoff assigns them. */
const SPEND_COLORS = ['var(--accent)', 'var(--primary)', 'var(--accent-deep)']

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Which sessions a failed server is holding up.
 *
 * A blocked session only carries its own error text, so attribution is a
 * substring match on the server's bare name (`plugin:github:github` -> `github`).
 * When nothing matches we report how many sessions are blocked overall rather
 * than blaming this server for them - a wrong consequence is worse than a vague
 * one.
 */
function blockedBy(
  server: string,
  vitals: SessionVitals[],
): { named: SessionVitals[]; total: number } {
  const blocked = vitals.filter((v) => v.state === 'blocked')
  const bare = server.slice(server.lastIndexOf(':') + 1).toLowerCase()
  const named = bare ? blocked.filter((v) => v.lastLine.toLowerCase().includes(bare)) : []
  return { named, total: blocked.length }
}

/**
 * Whether a server can be signed in to at all.
 *
 * Sign-in is offered whatever the status, including `connected` and `pending`.
 * An expired token can present as any of them, and a server you have never
 * authorized sits at `pending` until a session tries it - gating on needs-auth
 * alone made the button disappear exactly when it was wanted.
 *
 * The one real exclusion is a stdio server: it is a local command with no OAuth
 * config, so there is no flow to run. That button renders disabled rather than
 * missing, so the reason is visible instead of mysterious.
 */
function canSignIn(s: McpServerView): boolean {
  return s.appliesToCwd !== false
}

/**
 * Whether signing in could destroy something, and so needs a confirmation step.
 * `claude mcp login` revokes the existing tokens before it starts the new flow,
 * so abandoning it half way leaves the server signed out.
 *
 * Only `needs-auth` and `failed` provably have nothing to lose. Everything else
 * is gated, `pending` included: before a session has tried a server it sits at
 * `pending` whether or not it already holds a working token, and on a fresh
 * launch that is every server.
 */
function signInIsDestructive(s: McpServerView): boolean {
  return s.status !== 'needs-auth' && s.status !== 'failed'
}

function McpPanel({
  servers,
  onServers,
  clientId,
  onSignIn,
  vitals,
}: {
  servers: McpServerView[]
  onServers: (next: McpServerView[]) => void
  clientId: string
  /** Starts the OAuth flow for each of these in turn. */
  onSignIn: (names: string[]) => void
  vitals: SessionVitals[]
}): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<Record<string, string>>({})

  const reconnect = async (name: string): Promise<void> => {
    setBusy(name)
    setFailed((f) => {
      const { [name]: _drop, ...rest } = f
      return rest
    })
    try {
      const next = await desk.reconnectMcp(clientId, name)
      if (next.length) onServers(next)
    } catch (err) {
      setFailed((f) => ({ ...f, [name]: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(null)
    }
  }

  const [expanded, setExpanded] = useState<string | null>(null)
  // Every quiet bucket starts folded: the panel is a diagnostic surface, and a
  // healthy server has nothing to say beyond its own existence.
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const sorted = useMemo(
    () => [...servers].sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  )

  /** Broken first and expanded, everything else bucketed and folded. */
  const buckets = useMemo(() => {
    const active = sorted.filter((s) => s.appliesToCwd !== false)
    const of = (key: McpStatus): McpServerView[] => active.filter((s) => s.status === key)
    return {
      broken: [...of('failed'), ...of('needs-auth')],
      failed: of('failed'),
      needsAuth: of('needs-auth'),
      quiet: QUIET_SECTIONS.map((sec) => ({ ...sec, items: of(sec.key) })).filter(
        (sec) => sec.items.length > 0,
      ),
      other: sorted.filter((s) => s.appliesToCwd === false),
      counts: Object.fromEntries(
        COUNT_LABELS.map(({ key }) => [key, of(key).length]),
      ) as Record<McpStatus, number>,
    }
  }, [sorted])

  const isLive = sorted.some((s) => s.origin === 'live')
  const attention = buckets.broken.length

  /** `1 failed · 2 need auth · 4 connected` — counts only, never colored. */
  const summary = COUNT_LABELS.filter(({ key }) => buckets.counts[key] > 0)
    .map(({ key, label }) => `${buckets.counts[key]} ${label}`)
    .join(' · ')

  // Every server the Authorize button can actually start a flow for: a stdio
  // server is a local command with no OAuth config, so it is not one of them.
  // The label counts these, not all needs-auth servers, so it never promises
  // more flows than it will run.
  const authTargets = buckets.needsAuth.filter((s) => s.transport !== 'stdio')
  const authLabel =
    authTargets.length === 1 ? 'Authorize' : authTargets.length === 2 ? 'Authorize both' : 'Authorize all'

  const report = (): string =>
    sorted
      .map(
        (s) =>
          `${s.status.toUpperCase().padEnd(11)} ${(s.scope ?? '?').padEnd(8)} ${s.name}` +
          `${s.scopeDir ? `  [${s.scopeDir}]` : ''}${s.error ? `  (${s.error})` : ''}`,
      )
      .join('\n')

  /**
   * The full detail for one server. Unchanged from the flat list it used to
   * live in - a broken card opens it under `Logs`, a quiet bucket opens it
   * under its caret, and both want the same facts.
   */
  const detailOf = (s: McpServerView): React.ReactElement => (
    <div className="row-detail">
      {s.appliesToCwd === false && (
        <p className="panel-hint">
          Configured for a different directory, so it is not loaded in this session.
          {s.scopeDir ? ' Switch the working directory to use it.' : ''}
        </p>
      )}
      {s.url && (
        <div className="kv">
          <span>url</span>
          <code>{s.url}</code>
          <CopyButton text={s.url} />
        </div>
      )}
      {s.scope && (
        <div className="kv">
          <span>scope</span>
          <code>{s.scope}</code>
        </div>
      )}
      {s.scopeDir && (
        <div className="kv">
          <span>directory</span>
          <code title={s.scopeDir}>{s.scopeDir}</code>
          <CopyButton text={s.scopeDir} />
        </div>
      )}
      {s.serverVersion && (
        <div className="kv">
          <span>version</span>
          <code>{s.serverVersion}</code>
        </div>
      )}
      {s.needsAuthSince && (
        <div className="kv">
          <span>auth failed</span>
          <code>{new Date(s.needsAuthSince).toLocaleString()}</code>
        </div>
      )}
      {s.error && <div className="err-box">{s.error}</div>}
      {failed[s.name] && <div className="err-box">{failed[s.name]}</div>}

      <div className="row-actions">
        <button
          className="btn btn-sm"
          disabled={busy === s.name || s.origin !== 'live'}
          onClick={(e) => {
            e.stopPropagation()
            void reconnect(s.name)
          }}
          title={
            s.origin === 'live'
              ? `Retry the connection to ${s.name}`
              : 'Start a session first: reconnecting needs a running agent'
          }
        >
          {busy === s.name ? 'Reconnecting...' : 'Reconnect'}
        </button>
        {canSignIn(s) && (
          <button
            className="btn btn-sm btn-primary"
            disabled={s.transport === 'stdio'}
            onClick={(e) => {
              e.stopPropagation()
              onSignIn([s.name])
            }}
            title={
              s.transport === 'stdio'
                ? 'A local command server has no OAuth sign-in'
                : `Run the OAuth sign-in for ${s.name}`
            }
          >
            Sign in
          </button>
        )}
      </div>

      {canSignIn(s) && s.transport !== 'stdio' && (
        <p className="panel-hint">
          Sign in runs the OAuth flow in your browser. It clears this server's old tokens first, so
          finish it once you start.
        </p>
      )}
      {s.tools.length > 0 && (
        <div className="tool-list">
          <div className="kv">
            <span>{s.tools.length} tools</span>
            <CopyButton text={() => s.tools.map((t) => t.name).join('\n')} label="Copy names" />
          </div>
          <ul>
            {s.tools.map((t) => (
              <li key={t.name} title={t.description}>
                <code>{t.name}</code>
                {t.destructive && <span className="badge badge-failed">destructive</span>}
                {t.readOnly && <span className="badge badge-connected">read-only</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )

  /** One server inside an opened bucket: the old row, click to expand. */
  const serverItem = (s: McpServerView): React.ReactElement => (
    <li key={`${s.name}@${s.scopeDir ?? s.scope ?? ''}`} className="list-item">
      <div
        className={`row ${s.appliesToCwd === false ? 'is-inactive' : ''}`}
        onClick={() => setExpanded((e) => (e === s.name ? null : s.name))}
      >
        <span className={`dot dot-${s.status}`} />
        <span className="row-name">{s.name}</span>
        {s.scope && <span className={`scope-tag scope-${s.scope}`}>{s.scope}</span>}
        <span className="row-meta">{s.transport ?? ''}</span>
        <span className={`badge badge-${s.status}`}>{s.status}</span>
      </div>
      {expanded === s.name && detailOf(s)}
    </li>
  )

  /** Why a server is down, plus the two facts that usually explain it. */
  const reasonOf = (s: McpServerView): string =>
    [s.error, s.scope, s.transport].filter(Boolean).join(' · ')

  return (
    <div className="ix-mcp">
      <div className="ix-summary">
        <div className="ix-summary-top">
          <span className={`eyebrow ix-summary-head ${attention ? 'is-attn' : ''}`}>
            {attention
              ? `${plural(attention, 'server')} need attention`
              : buckets.counts.connected > 0
                ? `all ${plural(buckets.counts.connected, 'server')} connected`
                : 'nothing needs attention'}
          </span>
          <CopyButton text={report} label="Copy report" />
        </div>
        {summary && <div className="ix-summary-line">{summary}</div>}
        {!isLive && (
          <p className="ix-note">
            Start a session to see real connection state. Until then this is what is configured on
            disk plus the needs-auth cache.
          </p>
        )}
      </div>

      <div className="ix-cards">
        {buckets.failed.map((s) => {
          const { named, total } = blockedBy(s.name, vitals)
          return (
            <div key={s.name} className="ix-card">
              <div className="ix-card-row">
                <span className="dot dot-attn" />
                <span className="ix-card-name" title={s.name}>
                  {s.name}
                </span>
                <span className="ix-card-state">FAILED</span>
              </div>
              {reasonOf(s) && <div className="ix-card-reason">{reasonOf(s)}</div>}
              <div className="ix-card-actions">
                <button
                  className="obtn"
                  disabled={busy === s.name || s.origin !== 'live'}
                  onClick={() => void reconnect(s.name)}
                  title={
                    s.origin === 'live'
                      ? `Retry the connection to ${s.name}`
                      : 'Start a session first: reconnecting needs a running agent'
                  }
                >
                  {busy === s.name ? 'Reconnecting...' : 'Reconnect'}
                </button>
                <button
                  className="obtn obtn-quiet"
                  onClick={() => setExpanded((e) => (e === s.name ? null : s.name))}
                  title="Show the recorded error and connection detail"
                >
                  Logs
                </button>
                {/* Only claim a session is blocked by this server when its error
                    text actually names it; otherwise report the bare count. */}
                {named.length > 0 ? (
                  <span className="ix-card-note" title={named.map((v) => v.title).join('\n')}>
                    blocks {plural(named.length, 'session')}
                  </span>
                ) : total > 0 ? (
                  <span className="ix-card-note">{plural(total, 'session')} blocked</span>
                ) : null}
              </div>
              {expanded === s.name && detailOf(s)}
            </div>
          )
        })}

        {buckets.needsAuth.length > 0 && (
          // One card for all of them: the answer is the same sign-in either way.
          <div className="ix-card">
            {buckets.needsAuth.map((s) => (
              <div
                key={s.name}
                className="ix-card-row"
                onClick={() => setExpanded((e) => (e === s.name ? null : s.name))}
              >
                <span className="dot dot-attn" />
                <span className="ix-card-name" title={s.name}>
                  {s.name}
                </span>
                <span className="ix-card-state">NEEDS AUTH</span>
              </div>
            ))}
            <div className="ix-card-actions">
              <button
                className="obtn"
                disabled={!authTargets.length}
                onClick={() => authTargets.length && onSignIn(authTargets.map((s) => s.name))}
                title={
                  authTargets.length
                    ? authTargets.length > 1
                      ? `Runs the OAuth flow for each in turn: ${authTargets.map((s) => s.name).join(', ')}`
                      : `Run the OAuth sign-in for ${authTargets[0].name}`
                    : 'A local command server has no OAuth sign-in'
                }
              >
                {authLabel}
              </button>
              <span className="ix-card-note">
                {[buckets.needsAuth[0].scope, buckets.needsAuth[0].transport]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            {buckets.needsAuth.map((s) =>
              expanded === s.name ? <div key={`${s.name}-detail`}>{detailOf(s)}</div> : null,
            )}
          </div>
        )}

        {buckets.quiet.map((sec) => (
          <div key={sec.key} className="ix-group">
            <button className="ix-group-head" onClick={() => setOpen((o) => ({ ...o, [sec.key]: !o[sec.key] }))}>
              <span className={`dot ${sec.dot}`} />
              <span className="ix-group-label">
                {sec.items.length} {sec.label}
              </span>
              <span className="ix-group-detail">{sec.items.map((s) => s.name).join(', ')}</span>
              <span className="ix-caret">{open[sec.key] ? '▴' : '▾'}</span>
            </button>
            {open[sec.key] && (
              <div className="ix-group-body">
                <ul className="list">{sec.items.map(serverItem)}</ul>
              </div>
            )}
          </div>
        ))}

        {buckets.other.length > 0 && (
          <div className="ix-group is-quiet">
            <button className="ix-group-head" onClick={() => setOpen((o) => ({ ...o, other: !o.other }))}>
              <span className="ix-group-label">
                {buckets.other.length} configured for other directories
              </span>
              <span className="ix-group-detail" />
              <span className="ix-caret">{open.other ? '▴' : '▾'}</span>
            </button>
            {open.other && (
              <div className="ix-group-body">
                <ul className="list">{buckets.other.map(serverItem)}</ul>
              </div>
            )}
          </div>
        )}

        {sorted.length === 0 && <p className="ix-note">No MCP servers configured.</p>}
      </div>
    </div>
  )
}

function SkillsPanel({ skills }: { skills: SkillView[] }): React.ReactElement {
  const [filter, setFilter] = useState('')
  const [group, setGroup] = useState<string | null>(null)

  const namespaces = useMemo(() => {
    const set = new Map<string, number>()
    for (const s of skills) {
      const key = s.namespace ?? 'personal'
      set.set(key, (set.get(key) ?? 0) + 1)
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1])
  }, [skills])

  const visible = useMemo(() => {
    const q = filter.toLowerCase()
    const inGroup = skills.filter((s) => !group || (s.namespace ?? 'personal') === group)
    if (!q) return inGroup

    // Rank name hits above description hits, otherwise a common word in a
    // description buries the skill you actually typed the name of.
    const scored: { s: SkillView; score: number }[] = []
    for (const s of inGroup) {
      const name = s.name.toLowerCase()
      const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
      let score = -1
      if (name.startsWith(q) || bare.startsWith(q)) score = 0
      else if (name.includes(q)) score = 1
      else if (s.description.toLowerCase().includes(q)) score = 2
      if (score >= 0) scored.push({ s, score })
    }
    return scored.sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name)).map((x) => x.s)
  }, [skills, filter, group])

  const isLive = skills.some((s) => s.origin === 'live')

  return (
    <div className="panel">
      <div className="panel-head">
        <span>{skills.length} available</span>
        <span className={`origin-tag ${isLive ? 'is-live' : ''}`}>{isLive ? 'live' : 'from config'}</span>
        <CopyButton
          text={() => visible.map((s) => `/${s.name} - ${s.description}`).join('\n')}
          label="Copy list"
        />
      </div>

      <input
        className="filter"
        placeholder="Filter skills..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div className="chips">
        <button className={`chip ${group === null ? 'is-on' : ''}`} onClick={() => setGroup(null)}>
          all
        </button>
        {namespaces.map(([ns, n]) => (
          <button key={ns} className={`chip ${group === ns ? 'is-on' : ''}`} onClick={() => setGroup(ns)}>
            {ns} <span className="chip-n">{n}</span>
          </button>
        ))}
      </div>

      <ul className="list">
        {visible.map((s, i) => (
          <li key={`${s.name}-${i}`} className="list-item skill-item">
            <div className="row">
              <code className="row-name">/{s.name}</code>
              {s.argumentHint && <span className="row-meta">{s.argumentHint}</span>}
              <CopyButton text={`/${s.name}`} label="⌘" title={`Copy /${s.name}`} />
            </div>
            <p className="skill-desc">{s.description}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function AgentsPanel({ agents }: { agents: AgentView[] }): React.ReactElement {
  if (!agents.length) {
    return (
      <div className="panel">
        <p className="panel-hint">Start a session to list the subagents available to it.</p>
      </div>
    )
  }
  return (
    <div className="panel">
      <div className="panel-head">
        <span>{agents.length} subagents</span>
        <CopyButton text={() => agents.map((a) => `${a.name} - ${a.description}`).join('\n')} label="Copy list" />
      </div>
      <ul className="list">
        {agents.map((a, i) => (
          <li key={`${a.name}-${i}`} className="list-item skill-item">
            <div className="row">
              <code className="row-name">{a.name}</code>
              {a.model && <span className="row-meta">{a.model}</span>}
            </div>
            <p className="skill-desc">{a.description}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PluginsPanel({ plugins }: { plugins: PluginView[] }): React.ReactElement {
  return (
    <div className="panel">
      <div className="panel-head">
        <span>{plugins.length} installed</span>
        <CopyButton
          text={() => plugins.map((p) => `${p.name}@${p.marketplace} ${p.version} (${p.scope})`).join('\n')}
          label="Copy list"
        />
      </div>
      <ul className="list">
        {plugins.map((p) => (
          <li key={`${p.name}@${p.marketplace}@${p.installPath}`} className="list-item">
            <div className="row">
              <span className="row-name">{p.name}</span>
              <span className="row-meta">{p.marketplace}</span>
              <span className="badge">{p.scope}</span>
            </div>
            <div className="kv">
              <span>version</span>
              <code>{p.version.slice(0, 12)}</code>
              {p.lastUpdated && <span className="row-meta">{new Date(p.lastUpdated).toLocaleDateString()}</span>}
            </div>
            <div className="kv">
              <button className="linkish" onClick={() => void desk.openPath(p.installPath)}>
                Reveal install path
              </button>
              <CopyButton text={p.installPath} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function UsagePanel({
  usage,
  context,
}: {
  usage: UsageView | null
  context: ContextUsageView | null
}): React.ReactElement {
  if (!usage && !context) {
    return (
      <div className="panel">
        <p className="panel-hint">Usage data appears once a session has completed a turn.</p>
      </div>
    )
  }
  const pct =
    context?.contextWindow && context.contextWindow > 0
      ? Math.min(100, Math.round((context.totalTokens / context.contextWindow) * 100))
      : null

  return (
    <div className="panel">
      {usage && (
        <div className="stat-grid">
          <div className="stat">
            <span className="stat-n">${usage.totalCostUsd.toFixed(3)}</span>
            <span className="stat-l">session cost</span>
          </div>
          <div className="stat">
            <span className="stat-n">{usage.turns}</span>
            <span className="stat-l">turns</span>
          </div>
          <div className="stat">
            <span className="stat-n">{fmtTokens(usage.inputTokens)}</span>
            <span className="stat-l">input</span>
          </div>
          <div className="stat">
            <span className="stat-n">{fmtTokens(usage.outputTokens)}</span>
            <span className="stat-l">output</span>
          </div>
          <div className="stat">
            <span className="stat-n">{fmtTokens(usage.cacheReadTokens)}</span>
            <span className="stat-l">cache read</span>
          </div>
        </div>
      )}

      {context && (
        <>
          <div className="panel-head">
            <span>
              context {(context.totalTokens / 1000).toFixed(1)}k
              {context.contextWindow ? ` / ${(context.contextWindow / 1000).toFixed(0)}k` : ''}
            </span>
            {pct !== null && <span className="row-meta">{pct}%</span>}
          </div>
          {pct !== null && (
            <div className="meter">
              <div className="meter-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
          <ul className="list">
            {context.categories
              .filter((c) => c.tokens > 0)
              .sort((a, b) => b.tokens - a.tokens)
              .map((c) => (
                <li key={c.name} className="list-item">
                  <div className="row">
                    <span className="row-name">{c.name}</span>
                    <span className="row-meta">{(c.tokens / 1000).toFixed(1)}k</span>
                  </div>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  )
}

export function Inspector({
  refreshKey,
  clientId,
  cwd,
  profilesKey,
  onProfilesChanged,
  onClose,
  focus,
  busy = 0,
  vitals,
  spend,
  sessionLabel,
}: {
  clientId: string
  /** The session's directory, needed to list skills before a session exists. */
  cwd: string
  refreshKey: number
  profilesKey: number
  onProfilesChanged: () => void
  onClose: () => void
  /** Live status for every open conversation, for blocked-session attribution. */
  vitals: SessionVitals[]
  /** Today's spend, already aggregated across sessions. */
  spend: { tokens: number; cost: number; byModel: { model: string; tokens: number; cost: number }[] }
  /** Short name of the session on screen, for the CONTEXT heading. */
  sessionLabel: string
  /**
   * Ask for a tab from outside. The nonce is what makes it work twice: typing
   * `/mcp` again after clicking away to Skills has to bring MCP back, and a bare
   * tab value would already be equal to itself.
   */
  focus?: { tab: Tab; nonce: number }
  /** Conversations with work in flight, so the update button can warn first. */
  busy?: number
}): React.ReactElement {
  const [tab, setTab] = useState<Tab>('mcp')
  /**
   * Servers still to be signed in, current one first. A queue rather than a
   * single name because "Authorize both"/"Authorize all" promises a batch: it
   * used to start the flow for one server and silently stop, while the label
   * and tooltip claimed the rest would follow.
   */
  const [authQueue, setAuthQueue] = useState<string[]>([])
  const signingIn = authQueue[0] ?? null
  const [loadedView, setLoadedView] = useState<LoadedView>('skills')
  const [mcp, setMcp] = useState<McpServerView[]>([])
  const [skills, setSkills] = useState<SkillView[]>([])
  const [agents, setAgents] = useState<AgentView[]>([])
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [usage, setUsage] = useState<UsageView | null>(null)
  const [context, setContext] = useState<ContextUsageView | null>(null)
  /** True while a context clear is in flight, so the button cannot be double-fired. */
  const [clearing, setClearing] = useState(false)
  /** Bumped after a clear, to re-read the context meter against the new window. */
  const [ctxNonce, setCtxNonce] = useState(0)

  const refresh = useCallback(async () => {
    const [m, s, a, p, u, c] = await Promise.all([
      desk.mcp(clientId),
      desk.skills(clientId, cwd),
      desk.agents(clientId, cwd),
      desk.plugins(),
      desk.usage(clientId),
      desk.contextUsage(clientId),
    ])
    setMcp(m)
    setSkills(s)
    setAgents(a)
    setPlugins(p)
    setUsage(u)
    setContext(c)
  }, [clientId, cwd])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey, ctxNonce])

  useEffect(() => {
    if (focus) setTab(focus.tab)
  }, [focus?.nonce, focus?.tab])

  /**
   * The CLI holds the new credentials, but a session that is already running is
   * still sitting on the failed connection, so its tools stay missing until it
   * reconnects. Do that here rather than making the user press the other button.
   */
  const onAuthenticated = useCallback(() => {
    const name = signingIn
    void (async () => {
      if (name) {
        try {
          await desk.reconnectMcp(clientId, name)
        } catch {
          // No session running, or it is still settling. The refresh below still
          // picks up the status change.
        }
      }
      // Advance the queue: if the user asked for several, the next flow opens
      // as soon as this one lands.
      setAuthQueue((q) => q.slice(1))
      await refresh()
    })()
  }, [signingIn, clientId, refresh])

  const connected = mcp.filter((s) => s.status === 'connected').length
  const problems = mcp.filter((s) => s.status === 'failed' || s.status === 'needs-auth').length

  /** Context readout for the footer. Only drawn when the window size is known. */
  const ctxPct =
    context?.contextWindow && context.contextWindow > 0
      ? Math.min(100, Math.round((context.totalTokens / context.contextWindow) * 100))
      : null

  const models = spend.byModel.filter((m) => m.cost > 0 || m.tokens > 0)
  const splitTotal = models.reduce((n, m) => n + m.cost, 0)

  return (
    <aside className="inspector ix-inspector">
      <nav className="tabs ix-tabs">
        <button
          className={`ix-tab ${tab === 'mcp' ? 'is-on' : ''}`}
          onClick={() => setTab('mcp')}
        >
          {/* The dot is the whole point of the tab: it is the only place the
              panel shouts before you have opened it. */}
          {problems > 0 && <span className="dot dot-attn ix-tab-dot" />}
          MCP
          <span className={`tab-n ${problems ? 'is-warn' : ''}`}>
            {connected}/{mcp.length}
          </span>
        </button>
        <button
          className={`ix-tab ${tab === 'skills' ? 'is-on' : ''}`}
          onClick={() => setTab('skills')}
        >
          Skills <span className="tab-n">{skills.length}</span>
        </button>
        <button
          className={`ix-tab ${tab === 'profiles' ? 'is-on' : ''}`}
          onClick={() => setTab('profiles')}
        >
          Profiles
        </button>
        <button
          className={`ix-tab ${tab === 'usage' ? 'is-on' : ''}`}
          onClick={() => setTab('usage')}
        >
          Usage
        </button>
        <span className="ix-tab-spacer" />
        <button
          className="refresh"
          // Clear the cached pre-session lookup first, so this re-asks the CLI
          // instead of handing back the same list it already had.
          onClick={() => void desk.inspectRefresh().then(refresh)}
          title="Refresh"
        >
          ↻
        </button>
        <button className="tab-close" onClick={onClose} title="Hide panel (Cmd+I)">
          ›
        </button>
      </nav>

      {tab === 'skills' && (
        <div className="subnav">
          <button
            className={`chip ${loadedView === 'skills' ? 'is-on' : ''}`}
            onClick={() => setLoadedView('skills')}
          >
            Skills <span className="chip-n">{skills.length}</span>
          </button>
          <button
            className={`chip ${loadedView === 'agents' ? 'is-on' : ''}`}
            onClick={() => setLoadedView('agents')}
          >
            Agents <span className="chip-n">{agents.length}</span>
          </button>
          <button
            className={`chip ${loadedView === 'plugins' ? 'is-on' : ''}`}
            onClick={() => setLoadedView('plugins')}
          >
            Plugins <span className="chip-n">{plugins.length}</span>
          </button>
        </div>
      )}

      <div className="inspector-body">
        {tab === 'mcp' && (
          <McpPanel
            servers={mcp}
            onServers={setMcp}
            clientId={clientId}
            onSignIn={(names) => setAuthQueue(names)}
            vitals={vitals}
          />
        )}
        {tab === 'skills' && loadedView === 'skills' && <SkillsPanel skills={skills} />}
        {tab === 'skills' && loadedView === 'agents' && <AgentsPanel agents={agents} />}
        {tab === 'skills' && loadedView === 'plugins' && <PluginsPanel plugins={plugins} />}
        {tab === 'profiles' && <ProfilesPanel refreshKey={profilesKey} onChanged={onProfilesChanged} />}
        {tab === 'usage' && <UsagePanel usage={usage} context={context} />}
      </div>

      {/* Spend and context are footers, not a tab: they answer questions you
          have while reading the transcript, whichever tab is open. Nothing is
          drawn until there is a real figure behind it. */}
      {models.length > 0 && splitTotal > 0 && (
        <div className="ix-spend">
          <div className="ix-foot-head">
            <span className="eyebrow">Spend · today</span>
            <span className="rule-spacer" />
            <span className="ix-spend-tokens">{fmtTokens(spend.tokens)} tok</span>
            <span className="ix-spend-total">{fmtCost(spend.cost)}</span>
          </div>
          {/* The split between models is the story here, not a time series. */}
          <div className="ix-split">
            {models.map((m, i) => (
              <span
                key={m.model}
                style={{
                  width: `${(m.cost / splitTotal) * 100}%`,
                  background: SPEND_COLORS[i % SPEND_COLORS.length],
                }}
              />
            ))}
          </div>
          <div className="ix-spend-rows">
            {models.map((m, i) => (
              <div key={m.model} className="ix-spend-row">
                <span
                  className="ix-swatch"
                  style={{ background: SPEND_COLORS[i % SPEND_COLORS.length] }}
                />
                <span className="ix-spend-model" title={m.model}>
                  {m.model}
                </span>
                <span className="ix-spend-tok">{fmtTokens(m.tokens)}</span>
                <span className="ix-spend-cost">{fmtCost(m.cost)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {context && ctxPct !== null && (
        <div className="ix-context">
          <div className="ix-foot-head">
            <span className="eyebrow ix-context-head">Context · {sessionLabel}</span>
            <span className="rule-spacer" />
            <span className="ix-context-pct">{ctxPct}%</span>
          </div>
          <span className="ix-ctx-track">
            <span style={{ width: `${ctxPct}%` }} />
          </span>
          <div className="ix-context-foot">
            <span className="ix-context-tokens">
              {fmtTokens(context.totalTokens)} of {fmtTokens(context.contextWindow ?? 0)} tokens
            </span>
            {/*
              Confirmed before acting: the transcript survives, but whatever the
              agent was still carrying does not, and that is not recoverable.
              Saying so plainly is cheaper than an undo nobody can offer.
            */}
            <button
              className="obtn"
              disabled={clearing}
              title="Start a fresh context window, keeping this session"
              onClick={() => {
                const ok = window.confirm(
                  'Start a fresh context window for this session?\n\n' +
                    'The agent forgets everything so far. The transcript stays, ' +
                    'and the directory, model and profile are kept.',
                )
                if (!ok) return
                setClearing(true)
                void desk
                  .clearContext(clientId)
                  .finally(() => setClearing(false))
                  .then(() => setCtxNonce((n) => n + 1))
              }}
            >
              {clearing ? 'Clearing…' : 'Clear context'}
            </button>
          </div>
        </div>
      )}

      <UpdateRow busy={busy} />

      {signingIn && (
        <McpLogin
          name={signingIn}
          clientId={clientId}
          // A server that works today must not be revoked by a stray click.
          confirmFirst={signInIsDestructive(
            mcp.find((s) => s.name === signingIn) ?? ({ status: 'pending' } as McpServerView),
          )}
          // Cancelling abandons the whole batch, not just this one server.
          onClose={() => setAuthQueue([])}
          onAuthenticated={onAuthenticated}
        />
      )}
    </aside>
  )
}
