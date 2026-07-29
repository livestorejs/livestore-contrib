import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Tabs } from './Tabs.js'

const meta: Meta<typeof Tabs> = {
  title: 'Components/Tabs',
  component: Tabs,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="p-4 text-devtools-text min-h-screen">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof Tabs>

// Mock icon components
const InspectorIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-label="Inspector">
    <title>Inspector</title>
    <path d="M2 2h12v12H2V2zm1 1v10h10V3H3z" />
    <path d="M4 4h8v1H4V4zm0 2h6v1H4V6zm0 2h8v1H4V8z" />
  </svg>
)

const DatabaseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-label="Database">
    <title>Database</title>
    <ellipse cx="8" cy="4" rx="6" ry="2" />
    <path d="M2 4v4c0 1.1 2.7 2 6 2s6-.9 6-2V4" />
    <path d="M2 8v4c0 1.1 2.7 2 6 2s6-.9 6-2V8" />
  </svg>
)

const NetworkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-label="Network">
    <title>Network</title>
    <circle cx="3" cy="8" r="2" />
    <circle cx="13" cy="8" r="2" />
    <circle cx="8" cy="3" r="2" />
    <circle cx="8" cy="13" r="2" />
    <path d="M5 8h6M8 5v6" />
  </svg>
)

const PerformanceIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-label="Performance">
    <title>Performance</title>
    <path d="M8 2L3 14h10L8 2z" />
    <circle cx="8" cy="10" r="1" />
  </svg>
)

export const Default: Story = {
  render: () => (
    <div className="h-96">
      <Tabs defaultSelectedKey="elements">
        <Tabs.List>
          <Tabs.Tab id="elements" icon={<InspectorIcon />}>
            Elements
          </Tabs.Tab>
          <Tabs.Tab id="console">Console</Tabs.Tab>
          <Tabs.Tab id="sources">Sources</Tabs.Tab>
          <Tabs.Tab id="network" icon={<NetworkIcon />}>
            Network
          </Tabs.Tab>
          <Tabs.Tab id="performance" icon={<PerformanceIcon />}>
            Performance
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel id="elements">
          <div className="p-4">
            <h3 className="text-lg font-semibold mb-4 text-devtools-text">Elements Panel</h3>
            <div className="space-y-2">
              <div className="text-sm text-devtools-text-secondary">
                This panel shows the DOM structure and allows you to inspect and modify elements.
              </div>
              <div className="bg-devtools-surface p-3 rounded border border-devtools-border">
                <code className="text-xs font-mono text-devtools-text">
                  &lt;div class="container"&gt;
                  <br />
                  &nbsp;&nbsp;&lt;h1&gt;Hello World&lt;/h1&gt;
                  <br />
                  &nbsp;&nbsp;&lt;p&gt;Sample content&lt;/p&gt;
                  <br />
                  &lt;/div&gt;
                </code>
              </div>
            </div>
          </div>
        </Tabs.Panel>
        <Tabs.Panel id="console">
          <div className="p-4">
            <h3 className="text-lg font-semibold mb-4 text-devtools-text">Console Panel</h3>
            <div className="bg-devtools-surface p-3 rounded border border-devtools-border font-mono text-xs">
              <div className="text-blue-600 mb-1">&gt; console.log("Hello DevTools!")</div>
              <div className="text-devtools-text-secondary mb-1">Hello DevTools!</div>
              <div className="text-red-600 mb-1">&gt; console.error("Something went wrong")</div>
              <div className="text-red-600">❌ Something went wrong</div>
            </div>
          </div>
        </Tabs.Panel>
        <Tabs.Panel id="sources">
          <div className="p-4">
            <h3 className="text-lg font-semibold mb-4 text-devtools-text">Sources Panel</h3>
            <div className="bg-devtools-surface p-3 rounded border border-devtools-border">
              <div className="text-sm text-devtools-text-secondary mb-2">File Explorer</div>
              <div className="font-mono text-xs space-y-1 text-devtools-text">
                <div>📁 src/</div>
                <div className="ml-4">📄 index.js</div>
                <div className="ml-4">📄 components.js</div>
                <div>📁 public/</div>
                <div className="ml-4">📄 index.html</div>
              </div>
            </div>
          </div>
        </Tabs.Panel>
        <Tabs.Panel id="network">
          <div className="p-4">
            <h3 className="text-lg font-semibold mb-4 text-devtools-text">Network Panel</h3>
            <div className="space-y-2">
              <div className="bg-devtools-surface border border-devtools-border rounded">
                <div className="grid grid-cols-4 gap-4 p-2 border-b border-devtools-border text-xs font-semibold text-devtools-text-secondary">
                  <div>Name</div>
                  <div>Status</div>
                  <div>Type</div>
                  <div>Size</div>
                </div>
                <div className="grid grid-cols-4 gap-4 p-2 text-xs text-devtools-text">
                  <div>index.html</div>
                  <div className="text-green-600">200</div>
                  <div>document</div>
                  <div>1.2 KB</div>
                </div>
                <div className="grid grid-cols-4 gap-4 p-2 text-xs text-devtools-text">
                  <div>app.js</div>
                  <div className="text-green-600">200</div>
                  <div>script</div>
                  <div>45.3 KB</div>
                </div>
              </div>
            </div>
          </div>
        </Tabs.Panel>
        <Tabs.Panel id="performance">
          <div className="p-4">
            <h3 className="text-lg font-semibold mb-4 text-devtools-text">Performance Panel</h3>
            <div className="bg-devtools-surface p-3 rounded border border-devtools-border">
              <div className="text-sm text-devtools-text-secondary mb-2">Performance Metrics</div>
              <div className="space-y-2 text-xs text-devtools-text">
                <div className="flex justify-between">
                  <span>First Contentful Paint:</span>
                  <span className="text-green-600">1.2s</span>
                </div>
                <div className="flex justify-between">
                  <span>Largest Contentful Paint:</span>
                  <span className="text-yellow-600">2.1s</span>
                </div>
                <div className="flex justify-between">
                  <span>Cumulative Layout Shift:</span>
                  <span className="text-green-600">0.001</span>
                </div>
              </div>
            </div>
          </div>
        </Tabs.Panel>
      </Tabs>
    </div>
  ),
}

export const WithIcons: Story = {
  render: () => (
    <div className="h-96">
      <Tabs defaultSelectedKey="database">
        <Tabs.List>
          <Tabs.Tab id="inspector" icon={<InspectorIcon />}>
            Inspector
          </Tabs.Tab>
          <Tabs.Tab id="database" icon={<DatabaseIcon />}>
            Database
          </Tabs.Tab>
          <Tabs.Tab id="network" icon={<NetworkIcon />}>
            Network
          </Tabs.Tab>
          <Tabs.Tab id="performance" icon={<PerformanceIcon />}>
            Performance
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel id="inspector">
          <div className="p-4 text-devtools-text">Inspector panel content</div>
        </Tabs.Panel>
        <Tabs.Panel id="database">
          <div className="p-4 text-devtools-text">Database panel content with icon</div>
        </Tabs.Panel>
        <Tabs.Panel id="network">
          <div className="p-4 text-devtools-text">Network panel content</div>
        </Tabs.Panel>
        <Tabs.Panel id="performance">
          <div className="p-4 text-devtools-text">Performance panel content</div>
        </Tabs.Panel>
      </Tabs>
    </div>
  ),
}

export const ManyTabs: Story = {
  render: () => (
    <div className="h-96">
      <Tabs defaultSelectedKey="tab1">
        <Tabs.List>
          {Array.from({ length: 12 }, (_, i) => (
            <Tabs.Tab key={`tab${i + 1}`} id={`tab${i + 1}`}>
              Tab {i + 1}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {Array.from({ length: 12 }, (_, i) => (
          <Tabs.Panel key={`tab${i + 1}`} id={`tab${i + 1}`}>
            <div className="p-4 text-devtools-text">Content for Tab {i + 1}</div>
          </Tabs.Panel>
        ))}
      </Tabs>
    </div>
  ),
}

export const Controlled: Story = {
  render: () => {
    const [selectedKey, setSelectedKey] = React.useState('tab2')

    return (
      <div className="space-y-4">
        <div className="flex gap-2">
          <button
            type="button"
            className="px-3 py-1 bg-devtools-primary text-devtools-surface rounded text-xs"
            onClick={() => setSelectedKey('tab1')}
          >
            Go to Tab 1
          </button>
          <button
            type="button"
            className="px-3 py-1 bg-devtools-primary text-devtools-surface rounded text-xs"
            onClick={() => setSelectedKey('tab2')}
          >
            Go to Tab 2
          </button>
          <button
            type="button"
            className="px-3 py-1 bg-devtools-primary text-devtools-surface rounded text-xs"
            onClick={() => setSelectedKey('tab3')}
          >
            Go to Tab 3
          </button>
        </div>
        <div className="h-80">
          <Tabs selectedKey={selectedKey} onSelectionChange={(key) => setSelectedKey(String(key))}>
            <Tabs.List>
              <Tabs.Tab id="tab1">First Tab</Tabs.Tab>
              <Tabs.Tab id="tab2">Second Tab</Tabs.Tab>
              <Tabs.Tab id="tab3">Third Tab</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel id="tab1">
              <div className="p-4 text-devtools-text">
                First tab content - controlled externally
              </div>
            </Tabs.Panel>
            <Tabs.Panel id="tab2">
              <div className="p-4 text-devtools-text">
                Second tab content - controlled externally
              </div>
            </Tabs.Panel>
            <Tabs.Panel id="tab3">
              <div className="p-4 text-devtools-text">
                Third tab content - controlled externally
              </div>
            </Tabs.Panel>
          </Tabs>
        </div>
      </div>
    )
  },
}

export const MinimalExample: Story = {
  render: () => (
    <div className="h-64">
      <Tabs>
        <Tabs.List>
          <Tabs.Tab id="one">One</Tabs.Tab>
          <Tabs.Tab id="two">Two</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel id="one">
          <div className="p-4 text-devtools-text">Panel One</div>
        </Tabs.Panel>
        <Tabs.Panel id="two">
          <div className="p-4 text-devtools-text">Panel Two</div>
        </Tabs.Panel>
      </Tabs>
    </div>
  ),
}
