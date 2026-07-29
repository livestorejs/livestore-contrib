import { Schema } from '@livestore/utils/effect'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { JsonTreeViewer } from './JsonTreeViewer.js'

describe('JsonTreeViewer Effect 4 boundary', () => {
  it('renders consumer-owned Effect 4 schema annotations through the devtools viewer', () => {
    const schema = Schema.Struct({
      name: Schema.String.annotate({
        description: 'Consumer-created name',
        pretty: (value: string) => `person:${value}`,
      }),
    }).annotate({ identifier: 'Consumer.Record' })

    const render = () =>
      renderToStaticMarkup(
        <JsonTreeViewer
          data={{ name: 'Ada' }}
          schema={schema}
          hideRoot={false}
          initiallyExpandedDepth={3}
        />,
      )

    const html = render()
    expect(html).toContain('Consumer.Record')
    expect(html).toContain('person:Ada')
  })
})
