/**
 * Configuration for dsh-notify.
 *
 * Deployment-varying values live here rather than in code. A configuration with no
 * destination at all is a load-time failure: a notification plugin that cannot address
 * anyone is a misconfiguration, not a disabled feature.
 */

/**
 * Read the plugin configuration.
 *
 * Deployment-varying values live here rather than in code. A configuration with no
 * destination at all is a load-time failure: a notification plugin that cannot
 * address anyone is a misconfiguration, not a disabled feature.
 *
 * @param raw - the config object the Loader passed.
 * @returns the resolved settings.
 */
export function resolveConfig(raw) {
  const source = raw ?? {}
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  const settings = {
    discordWebhookUrl: text(source.discordWebhookUrl),
    imessageRecipient: text(source.imessageRecipient),
    discordBotToken: text(source.discordBotToken),
    discordChannelId: text(source.discordChannelId),
    discordAllowedUserId: text(source.discordAllowedUserId),
    label: text(source.label) === '' ? 'DSH' : text(source.label),
    components: source.components !== false,
    turnNotify: source.turnNotify !== false,
    ttlMs: Number.isInteger(source.ttlMs) && source.ttlMs >= 0 ? source.ttlMs : 300_000,
    minGapMs: Number.isInteger(source.minGapMs) && source.minGapMs >= 0 ? source.minGapMs : 2_000,
    replyWindowMs: Number.isInteger(source.replyWindowMs) && source.replyWindowMs >= 0
      ? source.replyWindowMs
      : 0,
    pollIntervalMs: Number.isInteger(source.pollIntervalMs) && source.pollIntervalMs >= 1_000
      ? source.pollIntervalMs
      : 3_000,
  }
  if (source.enabled === false) return { ...settings, enabled: false, answering: false }
  if (settings.discordWebhookUrl === '' && settings.imessageRecipient === '') {
    throw new Error('dsh-notify: configure `discordWebhookUrl` or `imessageRecipient`')
  }
  const replyParts = [settings.discordBotToken, settings.discordChannelId, settings.discordAllowedUserId]
  const configured = replyParts.filter(part => part !== '').length
  if (configured !== 0 && configured !== replyParts.length) {
    throw new Error('dsh-notify: answering from Discord needs all three of '
      + '`discordBotToken`, `discordChannelId`, `discordAllowedUserId`')
  }
  return { ...settings, enabled: true, answering: configured === replyParts.length }
}
