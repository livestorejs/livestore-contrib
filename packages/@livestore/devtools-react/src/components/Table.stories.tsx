import { Schema } from '@livestore/utils/effect'
import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'
import type * as RAC from 'react-aria-components'

import { JsonTreeViewer } from './JsonTreeViewer.js'
import { Table } from './Table.js'

const meta: Meta<typeof Table> = {
  title: 'Components/Table',
  component: Table,
  parameters: {
    layout: 'padded',
  },
  decorators: [
    (Story) => (
      <div className="p-4 bg-devtools-background text-devtools-text min-h-screen">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof Table>

const mockQueries = [
  {
    id: '1',
    type: 'SQL',
    runs: 15,
    executionTimes: [12, 15, 18, 22, 14, 16, 13, 19, 17, 21],
    subscribers: 3,
    result: { count: 42, items: ['item1', 'item2'] },
    label: 'getUsersQuery',
    hash: 'a1b2c3d4',
  },
  {
    id: '2',
    type: 'Effect',
    runs: 8,
    executionTimes: [5, 7, 6, 8, 5, 9, 7, 6],
    subscribers: 1,
    result: { status: 'success', data: 'processed' },
    label: 'processDataQuery',
    hash: 'e5f6g7h8',
  },
  {
    id: '3',
    type: 'GraphQL',
    runs: 23,
    executionTimes: [45, 52, 48, 55, 49, 51, 47, 53, 50, 54],
    subscribers: 7,
    result: { users: [{ name: 'John' }, { name: 'Jane' }] },
    label: 'fetchUserProfilesQuery',
    hash: 'i9j0k1l2',
  },
]

export const Default: Story = {
  render: () => (
    <Table>
      <Table.Header>
        <Table.Column width={30}>#</Table.Column>
        <Table.Column width={80}>Type</Table.Column>
        <Table.Column width={60}>Runs</Table.Column>
        <Table.Column width={180}>Duration (ms)</Table.Column>
        <Table.Column width={100}>Subscribers</Table.Column>
        <Table.Column width={200}>Result</Table.Column>
        <Table.Column>Label</Table.Column>
        <Table.Column width={100}>Hash</Table.Column>
      </Table.Header>
      <Table.Body>
        {mockQueries.map((query, index) => (
          <Table.Row key={query.id}>
            <Table.Cell>{index + 1}</Table.Cell>
            <Table.Cell>{query.type}</Table.Cell>
            <Table.Cell>{query.runs}</Table.Cell>
            <Table.Cell>{query.executionTimes.slice(-10).join(', ')}</Table.Cell>
            <Table.Cell>count: {query.subscribers}</Table.Cell>
            <Table.Cell>
              <div className="overflow-auto max-w-48">
                <JsonTreeViewer
                  data={query.result}
                  schema={Schema.Json}
                  initiallyExpandedDepth={1}
                  hideRoot={true}
                />
              </div>
            </Table.Cell>
            <Table.Cell>{query.label}</Table.Cell>
            <Table.Cell>{query.hash}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  ),
}

export const Resizable: Story = {
  render: () => (
    <Table.Container>
      <Table>
        <Table.Header>
          <Table.Column width={30} allowsResizing>
            #
          </Table.Column>
          <Table.Column width={80} allowsResizing>
            Type
          </Table.Column>
          <Table.Column width={60} allowsResizing>
            Runs
          </Table.Column>
          <Table.Column width={180} allowsResizing>
            Duration (ms)
          </Table.Column>
          <Table.Column width={100} allowsResizing>
            Subscribers
          </Table.Column>
          <Table.Column width={200} allowsResizing>
            Result
          </Table.Column>
          <Table.Column allowsResizing>Label</Table.Column>
          <Table.Column width={100} allowsResizing>
            Hash
          </Table.Column>
        </Table.Header>
        <Table.Body>
          {mockQueries.map((query, index) => (
            <Table.Row key={query.id}>
              <Table.Cell>{index + 1}</Table.Cell>
              <Table.Cell>{query.type}</Table.Cell>
              <Table.Cell>{query.runs}</Table.Cell>
              <Table.Cell>{query.executionTimes.slice(-10).join(', ')}</Table.Cell>
              <Table.Cell>count: {query.subscribers}</Table.Cell>
              <Table.Cell>
                <div className="overflow-auto max-w-48">
                  <JsonTreeViewer
                    data={query.result}
                    schema={Schema.Json}
                    initiallyExpandedDepth={1}
                    hideRoot={true}
                  />
                </div>
              </Table.Cell>
              <Table.Cell>{query.label}</Table.Cell>
              <Table.Cell>{query.hash}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </Table.Container>
  ),
}

export const Sortable: Story = {
  render: () => (
    <Table>
      <Table.Header>
        <Table.Column allowsSorting width={30}>
          #
        </Table.Column>
        <Table.Column allowsSorting width={80}>
          Type
        </Table.Column>
        <Table.Column allowsSorting width={60}>
          Runs
        </Table.Column>
        <Table.Column width={180}>Duration (ms)</Table.Column>
        <Table.Column allowsSorting width={100}>
          Subscribers
        </Table.Column>
        <Table.Column>Result</Table.Column>
        <Table.Column allowsSorting>Label</Table.Column>
        <Table.Column width={100}>Hash</Table.Column>
      </Table.Header>
      <Table.Body>
        {mockQueries.map((query, index) => (
          <Table.Row key={query.id}>
            <Table.Cell>{index + 1}</Table.Cell>
            <Table.Cell>{query.type}</Table.Cell>
            <Table.Cell>{query.runs}</Table.Cell>
            <Table.Cell>{query.executionTimes.slice(-10).join(', ')}</Table.Cell>
            <Table.Cell>count: {query.subscribers}</Table.Cell>
            <Table.Cell>
              <div className="overflow-auto max-w-48">
                <JsonTreeViewer
                  data={query.result}
                  schema={Schema.Json}
                  initiallyExpandedDepth={1}
                  hideRoot={true}
                />
              </div>
            </Table.Cell>
            <Table.Cell>{query.label}</Table.Cell>
            <Table.Cell>{query.hash}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  ),
}

export const Selectable: Story = {
  render: () => {
    const [selectedKeys, setSelectedKeys] = React.useState<RAC.Selection>(new Set())

    return (
      <Table
        selectionMode="multiple"
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
      >
        <Table.Header>
          <Table.Column width={30}>#</Table.Column>
          <Table.Column width={80}>Type</Table.Column>
          <Table.Column width={60}>Runs</Table.Column>
          <Table.Column width={180}>Duration (ms)</Table.Column>
          <Table.Column width={100}>Subscribers</Table.Column>
          <Table.Column width={200}>Result</Table.Column>
          <Table.Column>Label</Table.Column>
          <Table.Column width={100}>Hash</Table.Column>
        </Table.Header>
        <Table.Body>
          {mockQueries.map((query, index) => (
            <Table.Row key={query.id} id={query.id}>
              <Table.Cell>{index + 1}</Table.Cell>
              <Table.Cell>{query.type}</Table.Cell>
              <Table.Cell>{query.runs}</Table.Cell>
              <Table.Cell>{query.executionTimes.slice(-10).join(', ')}</Table.Cell>
              <Table.Cell>count: {query.subscribers}</Table.Cell>
              <Table.Cell>
                <div className="overflow-auto max-w-48">
                  <JsonTreeViewer
                    data={query.result}
                    schema={Schema.Json}
                    initiallyExpandedDepth={1}
                    hideRoot={true}
                  />
                </div>
              </Table.Cell>
              <Table.Cell>{query.label}</Table.Cell>
              <Table.Cell>{query.hash}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    )
  },
}

export const Empty: Story = {
  render: () => (
    <Table>
      <Table.Header>
        <Table.Column>Name</Table.Column>
        <Table.Column>Type</Table.Column>
        <Table.Column>Status</Table.Column>
      </Table.Header>
      <Table.Body>{[]}</Table.Body>
    </Table>
  ),
}

export const LargeDataset: Story = {
  render: () => {
    const largeDataset = Array.from({ length: 100 }, (_, i) => ({
      id: `${i + 1}`,
      type: ['SQL', 'Effect', 'GraphQL'][i % 3],
      runs: Math.floor(Math.random() * 50) + 1,
      executionTimes: Array.from({ length: 10 }, () => Math.floor(Math.random() * 100) + 5),
      subscribers: Math.floor(Math.random() * 10),
      result: { status: 'success', count: Math.floor(Math.random() * 1000) },
      label: `query${i + 1}`,
      hash: `hash${i + 1}`,
    }))

    return (
      <div className="h-96">
        <Table>
          <Table.Header>
            <Table.Column width={30}>#</Table.Column>
            <Table.Column width={80}>Type</Table.Column>
            <Table.Column width={60}>Runs</Table.Column>
            <Table.Column width={180}>Duration (ms)</Table.Column>
            <Table.Column width={100}>Subscribers</Table.Column>
            <Table.Column width={200}>Result</Table.Column>
            <Table.Column>Label</Table.Column>
            <Table.Column width={100}>Hash</Table.Column>
          </Table.Header>
          <Table.Body>
            {largeDataset.map((query, index) => (
              <Table.Row key={query.id}>
                <Table.Cell>{index + 1}</Table.Cell>
                <Table.Cell>{query.type}</Table.Cell>
                <Table.Cell>{query.runs}</Table.Cell>
                <Table.Cell>{query.executionTimes.slice(-5).join(', ')}</Table.Cell>
                <Table.Cell>count: {query.subscribers}</Table.Cell>
                <Table.Cell>
                  <div className="overflow-auto max-w-48">
                    {JSON.stringify(query.result, null, 2)}
                  </div>
                </Table.Cell>
                <Table.Cell>{query.label}</Table.Cell>
                <Table.Cell>{query.hash}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    )
  },
}
