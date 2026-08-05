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
import { CopyButton } from './Copy.js'
import { ProfilesPanel } from './Profiles.js'

type Tab = 'mcp' | 'skills' | 'profiles' | 'usage'
/** Agents and plugins are the same question as skills: what got loaded. */
type LoadedView = 'skills' | 'agents' | 'plugins'

/** Sections in the order you most likely need to act on them. */
const STATUS_SECTIONS: { key: McpStatus; label: string }[] = [
  { key: 'failed', label: 'Failed' },
  { key: 'needs-auth', label: 'Needs auth' },
  { key: 'connected', label: 'Connected' },
  { key: 'pending', label: 'Not started' },
  { key: 'disabled', label: 'Disabled' },
]

function McpPanel({
  servers,
  onServers,
}: {
  servers: McpServerView[]
  onServers: (next: McpServerView[]) => void
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
      const next = await desk.reconnectMcp(name)
      if (next.length) onServers(next)
    } catch (err) {
      setFailed((f) => ({ ...f, [name]: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(null)
    }
  }

  const [expanded, setExpanded] = useState<string | null>(null)
  const [closed, setClosed] = useState<Record<string, boolean>>({
    // Servers bound to another directory are informational, so start folded.
    other: true,
  })

  const sorted = useMemo(
    () => [...servers].sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  )

  /** One section per status, plus a trailing bucket for other directories. */
  const sections = useMemo(() => {
    const active = sorted.filter((s) => s.appliesToCwd !== false)
    const other = sorted.filter((s) => s.appliesToCwd === false)
    const out = STATUS_SECTIONS.map(({ key, label }) => ({
      id: key as string,
      label,
      status: key,
      items: active.filter((s) => s.status === key),
    })).filter((s) => s.items.length > 0)
    if (other.length) {
      out.push({ id: 'other', label: 'Other directories', status: 'pending' as McpStatus, items: other })
    }
    return out
  }, [sorted])

  const connected = sorted.filter((s) => s.status === 'connected').length
  const isLive = sorted.some((s) => s.origin === 'live')
  const inactive = sorted.filter((s) => s.appliesToCwd === false).length

  const report = (): string =>
    sorted
      .map(
        (s) =>
          `${s.status.toUpperCase().padEnd(11)} ${(s.scope ?? '?').padEnd(8)} ${s.name}` +
          `${s.scopeDir ? `  [${s.scopeDir}]` : ''}${s.error ? `  (${s.error})` : ''}`,
      )
      .join('\n')

  return (
    <div className="panel">
      <div className="panel-head">
        <span>
          {connected}/{sorted.length} connected
        </span>
        <span className={`origin-tag ${isLive ? 'is-live' : ''}`}>{isLive ? 'live' : 'from config'}</span>
        <CopyButton text={report} label="Copy report" />
      </div>

      {!isLive && (
        <p className="panel-hint">
          Start a session to see real connection state. Until then this is what is configured on disk plus the
          needs-auth cache.
        </p>
      )}
      {inactive > 0 && (
        <p className="panel-hint">
          {inactive} server{inactive === 1 ? '' : 's'} configured for another directory, shown dimmed.
        </p>
      )}

      {sections.map((sec) => (
        <div key={sec.id} className="mcp-sec">
          <button
            className="mcp-sec-head"
            onClick={() => setClosed((c) => ({ ...c, [sec.id]: !c[sec.id] }))}
          >
            <span className="grp-caret">{closed[sec.id] ? '\u25b8' : '\u25be'}</span>
            <span className={`dot dot-${sec.status}`} />
            <span className="mcp-sec-label">{sec.label}</span>
            <span className="mcp-sec-n">{sec.items.length}</span>
            <CopyButton
              text={() => sec.items.map((s) => s.name).join('\n')}
              label="Copy"
              title={`Copy the ${sec.label.toLowerCase()} server names`}
            />
          </button>

          {!closed[sec.id] && (
            <ul className="list">
              {sec.items.map((s) => (
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
            {expanded === s.name && (
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
                  {s.status === 'needs-auth' && (
                    <span className="row-meta">OAuth still needs /mcp in a session</span>
                  )}
                </div>

                {s.status === 'needs-auth' && (
                  <p className="panel-hint">
                    Reconnect retries the connection, but it cannot complete an OAuth sign-in. If it comes back
                    as needs-auth, run <code>/mcp</code> in a session to authorise, then reconnect here.
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
            )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
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

/** Uncached input is often only a few hundred tokens, so "0.0k" would hide it. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
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
  profilesKey,
  onProfilesChanged,
  onClose,
}: {
  refreshKey: number
  profilesKey: number
  onProfilesChanged: () => void
  onClose: () => void
}): React.ReactElement {
  const [tab, setTab] = useState<Tab>('mcp')
  const [loadedView, setLoadedView] = useState<LoadedView>('skills')
  const [mcp, setMcp] = useState<McpServerView[]>([])
  const [skills, setSkills] = useState<SkillView[]>([])
  const [agents, setAgents] = useState<AgentView[]>([])
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [usage, setUsage] = useState<UsageView | null>(null)
  const [context, setContext] = useState<ContextUsageView | null>(null)

  const refresh = useCallback(async () => {
    const [m, s, a, p, u, c] = await Promise.all([
      desk.mcp(),
      desk.skills(),
      desk.agents(),
      desk.plugins(),
      desk.usage(),
      desk.contextUsage(),
    ])
    setMcp(m)
    setSkills(s)
    setAgents(a)
    setPlugins(p)
    setUsage(u)
    setContext(c)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  const connected = mcp.filter((s) => s.status === 'connected').length
  const problems = mcp.filter((s) => s.status === 'failed' || s.status === 'needs-auth').length

  return (
    <aside className="inspector">
      <nav className="tabs">
        <button className={tab === 'mcp' ? 'is-on' : ''} onClick={() => setTab('mcp')}>
          MCP
          <span className={`tab-n ${problems ? 'is-warn' : ''}`}>
            {connected}/{mcp.length}
          </span>
        </button>
        <button className={tab === 'skills' ? 'is-on' : ''} onClick={() => setTab('skills')}>
          Skills <span className="tab-n">{skills.length}</span>
        </button>
        <button className={tab === 'profiles' ? 'is-on' : ''} onClick={() => setTab('profiles')}>
          Profiles
        </button>
        <button className={tab === 'usage' ? 'is-on' : ''} onClick={() => setTab('usage')}>
          Usage
        </button>
        <button className="refresh" onClick={() => void refresh()} title="Refresh">
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
        {tab === 'mcp' && <McpPanel servers={mcp} onServers={setMcp} />}
        {tab === 'skills' && loadedView === 'skills' && <SkillsPanel skills={skills} />}
        {tab === 'skills' && loadedView === 'agents' && <AgentsPanel agents={agents} />}
        {tab === 'skills' && loadedView === 'plugins' && <PluginsPanel plugins={plugins} />}
        {tab === 'profiles' && <ProfilesPanel refreshKey={profilesKey} onChanged={onProfilesChanged} />}
        {tab === 'usage' && <UsagePanel usage={usage} context={context} />}
      </div>
    </aside>
  )
}
