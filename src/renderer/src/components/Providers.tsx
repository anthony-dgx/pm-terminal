import { useCallback, useEffect, useState } from 'react'
import type { ModelOption, ProviderInput, ProviderView } from '../../../shared/types.js'
import { desk } from '../lib/api.js'

/**
 * Model providers: an Anthropic-compatible endpoint the `claude` binary talks to
 * instead of api.anthropic.com. Point one at a translating proxy and the same
 * session pipeline runs GPT or Gemini, with skills, plugins, MCP and permissions
 * all still in place, because the CLI underneath is unchanged.
 */

/** The models box is one per line, `value` or `value | Display name`. */
function parseModels(text: string): ModelOption[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, display] = line.split('|').map((s) => s.trim())
      return { value, displayName: display || value, description: '' }
    })
    .filter((m) => m.value)
}

function formatModels(models: ModelOption[]): string {
  return models
    .map((m) => (m.displayName && m.displayName !== m.value ? `${m.value} | ${m.displayName}` : m.value))
    .join('\n')
}

interface Draft {
  id?: string
  name: string
  baseUrl: string
  models: string
  smallFastModel: string
  /**
   * Undefined means "leave the stored token alone". The form starts there on an
   * edit, because the token cannot be read back to prefill the box.
   */
  token?: string
  hasToken: boolean
}

function draftOf(p?: ProviderView): Draft {
  return {
    id: p?.id,
    name: p?.name ?? '',
    baseUrl: p?.baseUrl ?? '',
    models: p ? formatModels(p.models) : '',
    smallFastModel: p?.smallFastModel ?? '',
    hasToken: p?.hasToken ?? false,
  }
}

export function ProvidersPanel(): React.ReactElement {
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [managed, setManaged] = useState<string | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await desk.providersList()
    setProviders(res.providers)
    setActiveId(res.activeId)
    setManaged(res.managedBaseUrl)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const choose = async (id: string | null): Promise<void> => {
    setActiveId(id)
    await desk.providersSetActive(id)
  }

  const save = async (d: Draft): Promise<void> => {
    const input: ProviderInput = {
      id: d.id,
      name: d.name,
      baseUrl: d.baseUrl,
      models: parseModels(d.models),
      smallFastModel: d.smallFastModel || undefined,
      // Only send the key when it was touched, so saving a rename does not
      // clear a token the form never had.
      ...(d.token !== undefined ? { token: d.token } : {}),
    }
    setProviders(await desk.providersSave(input))
    setEditing(null)
  }

  // Shown in both views, because a pinned base URL makes the whole panel a
  // no-op and finding that out after configuring one is worse.
  const policy = managed && (
    <div className="warn-box">
      An administrator policy pins the endpoint to <code>{managed}</code>. Providers configured here
      will not take effect on this machine: managed settings override the environment.
    </div>
  )

  if (editing) {
    const d = editing
    return (
      <div className="panel">
        <div className="panel-head">
          <span>{d.id ? 'Edit provider' : 'New provider'}</span>
        </div>

        {policy}

        <label className="field">
          <span>Name</span>
          <input
            className="filter"
            value={d.name}
            onChange={(e) => setEditing({ ...d, name: e.target.value })}
            placeholder="OpenRouter"
          />
        </label>

        <label className="field">
          <span>Base URL</span>
          <input
            className="filter"
            value={d.baseUrl}
            onChange={(e) => setEditing({ ...d, baseUrl: e.target.value })}
            placeholder="http://localhost:4000"
          />
        </label>

        <label className="field">
          <span>API token</span>
          <input
            className="filter"
            type="password"
            value={d.token ?? ''}
            onChange={(e) => setEditing({ ...d, token: e.target.value })}
            placeholder={d.hasToken ? 'Stored. Type to replace.' : 'sk-...'}
          />
        </label>
        <p className="panel-hint">
          Kept in the system keychain, not in the app&apos;s settings file, and never sent to the
          window you are looking at.
        </p>

        <label className="field">
          <span>Models</span>
          <textarea
            className="profile-prompt"
            value={d.models}
            onChange={(e) => setEditing({ ...d, models: e.target.value })}
            placeholder={'openai/gpt-5\nopenai/gpt-5-mini | GPT-5 mini'}
            rows={8}
          />
        </label>
        <p className="panel-hint">
          One per line, exactly as the endpoint names them. Add <code>| Display name</code> to change
          what the picker shows. An endpoint cannot be asked what it serves, so this list is typed
          in, and at least one is required.
        </p>

        <label className="field">
          <span>Small fast model</span>
          <input
            className="filter"
            value={d.smallFastModel}
            onChange={(e) => setEditing({ ...d, smallFastModel: e.target.value })}
            placeholder="openai/gpt-5-mini"
          />
        </label>
        <p className="panel-hint">
          Claude Code reaches for a cheap model on its own for background work and asks for it by a
          Haiku name, which your endpoint will not recognise. Map it here.
        </p>

        <div className="row-actions">
          <button
            className="btn btn-primary btn-sm"
            // At least one model is required. With an empty list there is
            // nothing to start a session on, so the CLI would fall back to a
            // Claude name and the picker would offer Claude aliases, both
            // against an endpoint that serves neither.
            disabled={!d.name.trim() || !d.baseUrl.trim() || !parseModels(d.models).length}
            onClick={() => void save(d)}
          >
            Save
          </button>
          <button className="btn btn-sm" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span>
          {providers.length} provider{providers.length === 1 ? '' : 's'}
        </span>
        <button className="btn btn-sm" onClick={() => setEditing(draftOf())}>
          + New
        </button>
      </div>

      {policy}

      <ul className="list">
        <li className="list-item skill-item">
          <div className="row">
            <span className="row-name">Anthropic</span>
            {!activeId && <span className="badge">in use</span>}
          </div>
          <p className="skill-desc">However Claude Code is already configured. The default.</p>
          {activeId && (
            <div className="row-actions">
              <button className="btn btn-sm" onClick={() => void choose(null)}>
                Use this
              </button>
            </div>
          )}
        </li>

        {providers.map((p) => (
          <li key={p.id} className="list-item skill-item">
            <div className="row">
              <span className="row-name">{p.name}</span>
              {activeId === p.id && <span className="badge">in use</span>}
              {!p.hasToken && <span className="badge">no token</span>}
            </div>
            <p className="skill-desc">
              {p.baseUrl} · {p.models.length} model{p.models.length === 1 ? '' : 's'}
            </p>
            <div className="row-actions">
              {activeId !== p.id && (
                <button className="btn btn-sm" onClick={() => void choose(p.id)}>
                  Use this
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setEditing(draftOf(p))}>
                Edit
              </button>
              {confirmDelete === p.id ? (
                <>
                  <button
                    className="btn btn-sm btn-deny"
                    onClick={() => {
                      void (async () => {
                        setProviders(await desk.providersRemove(p.id))
                        if (activeId === p.id) setActiveId(null)
                        setConfirmDelete(null)
                      })()
                    }}
                  >
                    Really delete
                  </button>
                  <button className="btn btn-sm" onClick={() => setConfirmDelete(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="btn btn-sm btn-deny" onClick={() => setConfirmDelete(p.id)}>
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <p className="panel-hint">
        Applies to sessions you start from now on. Conversations already running stay on the endpoint
        they started with.
      </p>
    </div>
  )
}
