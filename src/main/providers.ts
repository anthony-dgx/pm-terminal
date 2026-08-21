import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { safeStorage } from 'electron'
import type { ModelOption, ProviderInput, ProviderView } from '../shared/types.js'
import { readPrefs, writePrefs } from './prefs.js'

/**
 * A model provider: an Anthropic-compatible endpoint the `claude` binary talks
 * to instead of api.anthropic.com. Point one at a translating proxy (LiteLLM,
 * OpenRouter) and the same session pipeline runs GPT or Gemini, with every
 * Claude Code feature - skills, plugins, MCP, permissions - still in place.
 *
 * Only the endpoint changes. The transcript still lands in ~/.claude/projects
 * and resume still works, because the CLI underneath is unchanged.
 */
export interface StoredProvider {
  id: string
  name: string
  /** Becomes ANTHROPIC_BASE_URL. */
  baseUrl: string
  /**
   * The token, encrypted with the OS keychain via `safeStorage`, base64'd.
   * Never leaves the main process and is never sent over IPC.
   */
  tokenEnc?: string
  /**
   * Plaintext fallback for machines where `safeStorage` has no backend. Written
   * only when encryption is unavailable, so the common path keeps the token out
   * of prefs.json.
   */
  tokenPlain?: string
  /**
   * What the model picker offers. A proxy cannot be asked what it serves, so
   * this is typed in rather than discovered.
   */
  models: ModelOption[]
  /**
   * Claude Code reaches for a small model on its own for background work and
   * asks for a Haiku name, which a proxy will not recognise. Map it here.
   */
  smallFastModel?: string
}

function decrypt(p: StoredProvider): string | undefined {
  if (p.tokenPlain) return p.tokenPlain
  if (!p.tokenEnc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(p.tokenEnc, 'base64'))
  } catch {
    // Keychain entry gone, or prefs copied from another machine. Treat as unset
    // rather than failing the whole session start.
    return undefined
  }
}

export async function readProviders(): Promise<StoredProvider[]> {
  return (await readPrefs()).providers ?? []
}

/** Where an administrator's policy file lives, per platform. */
function managedSettingsPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (process.platform === 'win32') return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json'
  return '/etc/claude-code/managed-settings.json'
}

/**
 * The base URL an administrator has pinned, if any.
 *
 * Managed settings outrank the environment, so on a machine under policy a
 * provider's `ANTHROPIC_BASE_URL` is quietly ignored and every session goes to
 * the corporate endpoint regardless. Worth saying out loud in the UI: the
 * failure is otherwise invisible, because sessions still work - just not
 * against the endpoint that was configured.
 */
export async function managedBaseUrl(): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(managedSettingsPath(), 'utf8')) as {
      env?: Record<string, unknown>
    }
    const url = raw?.env?.ANTHROPIC_BASE_URL
    return typeof url === 'string' && url ? url : null
  } catch {
    // No policy file, or unreadable. Either way, nothing to warn about.
    return null
  }
}

/** The renderer's view: everything except the token itself. */
export async function listProviders(): Promise<{
  providers: ProviderView[]
  activeId: string | null
  managedBaseUrl: string | null
}> {
  const prefs = await readPrefs()
  const providers = (prefs.providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    models: p.models,
    smallFastModel: p.smallFastModel,
    hasToken: Boolean(p.tokenEnc || p.tokenPlain),
  }))
  return {
    providers,
    activeId: prefs.activeProviderId ?? null,
    managedBaseUrl: await managedBaseUrl(),
  }
}

/**
 * Create or update one provider. `token` is three-valued on purpose: absent
 * leaves the stored one alone, so editing a name does not force the user to
 * retype a secret they cannot read back; empty clears it.
 */
export async function saveProvider(input: ProviderInput): Promise<ProviderView[]> {
  const existing = await readProviders()
  const prev = input.id ? existing.find((p) => p.id === input.id) : undefined

  const next: StoredProvider = {
    id: prev?.id ?? randomUUID(),
    name: input.name.trim() || 'Provider',
    baseUrl: input.baseUrl.trim(),
    models: input.models,
    smallFastModel: input.smallFastModel?.trim() || undefined,
    tokenEnc: prev?.tokenEnc,
    tokenPlain: prev?.tokenPlain,
  }

  if (input.token !== undefined) {
    const token = input.token.trim()
    next.tokenEnc = undefined
    next.tokenPlain = undefined
    if (token) {
      if (safeStorage.isEncryptionAvailable()) {
        next.tokenEnc = safeStorage.encryptString(token).toString('base64')
      } else {
        next.tokenPlain = token
      }
    }
  }

  const providers = prev
    ? existing.map((p) => (p.id === prev.id ? next : p))
    : [...existing, next]
  await writePrefs({ providers })
  return (await listProviders()).providers
}

export async function removeProvider(id: string): Promise<ProviderView[]> {
  const prefs = await readPrefs()
  await writePrefs({
    providers: (prefs.providers ?? []).filter((p) => p.id !== id),
    // Deleting the active one falls back to Anthropic rather than leaving a
    // dangling id that silently starts sessions on the default endpoint anyway.
    activeProviderId: prefs.activeProviderId === id ? null : prefs.activeProviderId,
  })
  return (await listProviders()).providers
}

export async function setActiveProvider(id: string | null): Promise<void> {
  await writePrefs({ activeProviderId: id })
}

export async function activeProvider(): Promise<StoredProvider | null> {
  const prefs = await readPrefs()
  if (!prefs.activeProviderId) return null
  return (prefs.providers ?? []).find((p) => p.id === prefs.activeProviderId) ?? null
}

/**
 * The environment overrides for a provider. The caller merges these over
 * `process.env` - the SDK replaces the child's whole environment when `env` is
 * passed, so handing it these alone would strip PATH and HOME.
 *
 * An `undefined` value means *remove the inherited variable*, which is not the
 * same as leaving it out. Anything Anthropic-credential-shaped that this process
 * inherited has to be cleared, or a provider saved without a token would send
 * the developer's own `ANTHROPIC_API_KEY` to whatever URL they typed in.
 */
/**
 * The model to actually start on. A provider's list is the whole truth about
 * what its endpoint serves, so anything outside it - the CLI's Claude default,
 * or a name carried in from a resumed transcript - is replaced by the first one
 * configured. Returns the caller's choice untouched if the provider lists no
 * models at all, since there is nothing better to offer.
 */
export function providerModel(p: StoredProvider, requested?: string): string | undefined {
  if (!p.models.length) return requested
  if (requested && p.models.some((m) => m.value === requested)) return requested
  return p.models[0].value
}

export function providerEnv(p: StoredProvider): Record<string, string | undefined> {
  const token = decrypt(p)
  const env: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: p.baseUrl,
    // Set to the provider's token, or explicitly cleared. Never inherited.
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: token,
    // Identifying headers belong to the endpoint they were configured for, not
    // to a third party the user just pointed us at.
    ANTHROPIC_CUSTOM_HEADERS: undefined,
  }
  // Cleared when unset, for the same reason as the token: a Haiku name left in
  // the shell would otherwise be asked of an endpoint that does not serve it.
  env.ANTHROPIC_SMALL_FAST_MODEL = p.smallFastModel
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = p.smallFastModel
  return env
}
