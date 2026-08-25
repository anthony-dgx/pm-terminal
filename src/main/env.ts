/**
 * Configuration read from the environment, under both names.
 *
 * The app was called Claude Desk before it was renamed to Atelier. Anyone who
 * had put `CLAUDE_DESK_CLI_PATH` or `CLAUDE_DESK_DEFAULT_CWD` in a shell
 * profile should not have it quietly stop working, so the old name is still
 * read. The new one wins when both are set.
 */
export function envVar(suffix: string): string | undefined {
  return process.env[`ATELIER_${suffix}`] || process.env[`CLAUDE_DESK_${suffix}`] || undefined
}
