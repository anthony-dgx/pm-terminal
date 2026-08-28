/**
 * Model values routed through the Datadog AI Gateway proxy.
 *
 * Atelier namespaces them rather than using the proxy's own client-facing names
 * (`claude-glm-5.2[1m]` and friends). Two reasons. The proxy publishes each
 * model under several aliases, and some of those aliases are `sonnet` and
 * `opus`, so a bare alias resolves to something surprising. And the namespace
 * makes "is this routed through the gateway" a string test rather than a lookup,
 * which is what the spawn path and the model switcher both need.
 *
 * The suffix is the proxy's exact `name` from its `config.json`, which is what
 * `--aigw-model` expects.
 */
export const GATEWAY_PREFIX = 'aigw:'

/** The proxy's model name for a gateway value, or null for a native Claude model. */
export function gatewayModelName(model: string | null | undefined): string | null {
  if (!model || !model.startsWith(GATEWAY_PREFIX)) return null
  const name = model.slice(GATEWAY_PREFIX.length)
  return name || null
}

export function isGatewayModel(model: string | null | undefined): boolean {
  return gatewayModelName(model) !== null
}
