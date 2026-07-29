import { defineEvent } from '@livestore/common/schema'
import { Schema } from '@livestore/utils/effect'
import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'
import * as RAC from 'react-aria-components'

import { ConfirmModalProvider } from '../../ConfirmModalContext.js'
import { CreateEventModal } from './CreateEventModal.js'

const sampleEvents = [
  defineEvent({
    name: 'v1.TodoCreated',
    schema: Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      createdAt: Schema.Date,
    }),
  }),
  defineEvent({
    name: 'v1.TaskWithMeta',
    schema: Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      metadata: Schema.Struct({
        owner: Schema.String,
        schedule: Schema.Struct({
          at: Schema.Date,
          repeat: Schema.optional(Schema.Literals(['daily', 'weekly'])),
        }),
        extra: Schema.Union([Schema.String, Schema.Finite]),
      }),
    }),
  }),
  defineEvent({
    name: 'v1.TodoToggled',
    schema: Schema.Struct({
      id: Schema.String,
      completed: Schema.Boolean,
    }),
  }),
  defineEvent({
    name: 'v1.ClientNote',
    schema: Schema.Struct({
      message: Schema.String,
      visibility: Schema.Literals(['private', 'public']),
    }),
    clientOnly: true,
  }),
  defineEvent({
    name: 'v1.TimestampFromNumber',
    schema: Schema.Struct({
      id: Schema.String,
      description: Schema.String,
      sentAt: Schema.DateFromMillis,
    }),
  }),
]

const meta: Meta<typeof CreateEventModal> = {
  title: 'DevTools Tabs/Events/CreateEventModal',
  component: CreateEventModal,
  parameters: {
    backgrounds: { default: 'dark' },
  },
}

export default meta

type Story = StoryObj<typeof meta>

const StoryWrapper: React.FC = () => {
  const [isOpen, setIsOpen] = React.useState(true)
  const [lastPayload, setLastPayload] = React.useState<string | undefined>(undefined)

  return (
    <ConfirmModalProvider>
      <div className="min-h-screen bg-devtools-surface p-6 text-devtools-text">
        <div className="mb-4 flex items-center gap-3">
          <RAC.Button
            onPress={() => setIsOpen(true)}
            className="rounded-md bg-devtools-focus px-3 py-2 text-sm font-semibold text-white hover:bg-devtools-focus/90"
          >
            Open modal
          </RAC.Button>
          {lastPayload && (
            <div className="text-xs text-devtools-text-secondary">
              Last submitted payload stored below. Refresh to reset.
            </div>
          )}
        </div>
        {lastPayload && (
          <pre className="mb-4 max-w-3xl overflow-auto rounded-md border border-devtools-border bg-devtools-surface-secondary p-3 text-xs text-devtools-text">
            {lastPayload}
          </pre>
        )}
        <CreateEventModal
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          eventDefs={sampleEvents}
          onSubmit={async (payload) => {
            setLastPayload(JSON.stringify(payload, null, 2))
          }}
        />
      </div>
    </ConfirmModalProvider>
  )
}

export const Basic: Story = {
  render: () => <StoryWrapper />,
}
