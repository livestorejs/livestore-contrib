/** Discord-visible command copy derived from the accepted data-use contract. */
export const docsCommandDescription =
  'Ask LiveStore docs via OpenAI (store:false); no ambient chat or bot-retained query/answer content.'

export const docsDataUseNotice = [
  '`/docs` sends only your explicit query and selected public LiveStore documentation to OpenAI.',
  'It does not send ambient Discord history, usernames, timestamps, or message metadata.',
  'The bot does not persist your query, the provider payload, or the generated answer.',
  '`store:false` disables Responses storage but is not Zero Data Retention; standard provider abuse-monitoring retention may still apply.',
].join(' ')

/** Public notice required before enabling AI titles for any configured channel. */
export const aiTitleDataUseNotice = [
  'In configured public channels, OpenAI may receive up to 500 characters of redacted public message text to suggest a thread title (`store:false`).',
  'User, role, and channel mentions, custom emoji identifiers, links, usernames, IDs, timestamps, history, and attachments are excluded.',
  'If generation is unavailable or invalid, the bot derives a local title instead.',
].join(' ')
