import { Schema } from '@livestore/utils/effect'

export * as ChromeExtension from './chrome-extension.js'
export { devtoolsProtocolVersion } from './protocol-version.js'

export class CopyToClipboard extends Schema.TaggedClass<CopyToClipboard>()(
  'Background.CopyToClipboard',
  {
    text: Schema.String,
  },
) {}

export class EscapeKey extends Schema.TaggedClass<EscapeKey>()('EscapeKey', {}) {}
