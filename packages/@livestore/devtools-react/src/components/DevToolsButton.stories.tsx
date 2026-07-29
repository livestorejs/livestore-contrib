import type { Meta, StoryObj } from '@storybook/react'

import { ThemeProvider } from '../theme/ThemeProvider.js'
import { DevToolsButton } from './DevToolsButton.js'

const meta: Meta<typeof DevToolsButton> = {
  title: 'Components/DevToolsButton',
  component: DevToolsButton,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Chrome DevTools-styled button component with multiple variants and sizes.',
      },
    },
  },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <div className="bg-devtools-background min-h-screen p-4">
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: ['default', 'primary', 'danger'],
      description: 'Button variant style',
    },
    size: {
      control: { type: 'select' },
      options: ['sm', 'xs'],
      description: 'Button size',
    },
    disabled: {
      control: { type: 'boolean' },
      description: 'Disabled state',
    },
    children: {
      control: { type: 'text' },
      description: 'Button content',
    },
  },
}

export default meta
type Story = StoryObj<typeof DevToolsButton>

// Basic variants
export const Default: Story = {
  args: {
    children: 'Default Button',
    variant: 'default',
    size: 'sm',
  },
}

export const Primary: Story = {
  args: {
    children: 'Primary Button',
    variant: 'primary',
    size: 'sm',
  },
}

export const Danger: Story = {
  args: {
    children: 'Danger Button',
    variant: 'danger',
    size: 'sm',
  },
}

// Size variants
export const SmallSize: Story = {
  args: {
    children: 'Small Button',
    size: 'sm',
  },
}

export const ExtraSmallSize: Story = {
  args: {
    children: 'Extra Small Button',
    size: 'xs',
  },
}

// States
export const Disabled: Story = {
  args: {
    children: 'Disabled Button',
    disabled: true,
  },
}

export const DisabledPrimary: Story = {
  args: {
    children: 'Disabled Primary',
    variant: 'primary',
    disabled: true,
  },
}

export const DisabledDanger: Story = {
  args: {
    children: 'Disabled Danger',
    variant: 'danger',
    disabled: true,
  },
}

// Interactive examples
export const WithIcons: Story = {
  args: {
    children: '▶︎ Play',
    variant: 'primary',
    size: 'sm',
  },
}

export const ShortText: Story = {
  args: {
    children: 'OK',
    size: 'xs',
  },
}

export const LongText: Story = {
  args: {
    children: 'Copy Snapshot to Clipboard',
    size: 'sm',
  },
}

// All variants showcase
export const AllVariants: Story = {
  render: () => (
    <div className="space-y-6">
      <div className="space-y-4">
        <h3 className="text-devtools-text font-medium">Size: sm</h3>
        <div className="flex flex-wrap gap-3">
          <DevToolsButton variant="default" size="sm">
            Default
          </DevToolsButton>
          <DevToolsButton variant="primary" size="sm">
            Primary
          </DevToolsButton>
          <DevToolsButton variant="danger" size="sm">
            Danger
          </DevToolsButton>
          <DevToolsButton variant="default" size="sm" disabled>
            Disabled
          </DevToolsButton>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-devtools-text font-medium">Size: xs</h3>
        <div className="flex flex-wrap gap-3">
          <DevToolsButton variant="default" size="xs">
            Default
          </DevToolsButton>
          <DevToolsButton variant="primary" size="xs">
            Primary
          </DevToolsButton>
          <DevToolsButton variant="danger" size="xs">
            Danger
          </DevToolsButton>
          <DevToolsButton variant="default" size="xs" disabled>
            Disabled
          </DevToolsButton>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-devtools-text font-medium">Real-world examples</h3>
        <div className="flex flex-wrap gap-3">
          <DevToolsButton variant="default" size="xs">
            Reset Slow Queries
          </DevToolsButton>
          <DevToolsButton variant="primary" size="xs">
            ▶︎ Resume
          </DevToolsButton>
          <DevToolsButton variant="default" size="xs">
            ⏸︎ Pause
          </DevToolsButton>
          <DevToolsButton variant="danger" size="xs">
            Reset all data
          </DevToolsButton>
          <DevToolsButton variant="default" size="xs">
            Copy
          </DevToolsButton>
          <DevToolsButton variant="default" size="xs">
            Re-run
          </DevToolsButton>
          <DevToolsButton variant="default" size="sm">
            Export DB (1 kB, fileName: database.db)
          </DevToolsButton>
        </div>
      </div>
    </div>
  ),
}

// Chrome DevTools comparison
export const ChromeDevToolsComparison: Story = {
  render: () => (
    <div className="space-y-6">
      <div className="bg-devtools-surface border border-devtools-border rounded p-4">
        <h3 className="text-devtools-text font-medium mb-4">
          Chrome DevTools Application Tab Style
        </h3>
        <p className="text-devtools-text-secondary text-sm mb-4">
          These buttons should match the styling in Chrome DevTools &gt; Application tab.
        </p>

        <div className="space-y-4">
          <div className="flex items-center space-x-2">
            <span className="text-devtools-text-secondary text-sm">Storage actions:</span>
            <DevToolsButton size="xs">Clear site data</DevToolsButton>
            <label className="flex items-center space-x-1 text-devtools-text-secondary text-sm">
              <input type="checkbox" className="text-devtools-focus" />
              <span>including third-party cookies</span>
            </label>
          </div>

          <div className="flex items-center space-x-2">
            <span className="text-devtools-text-secondary text-sm">Database actions:</span>
            <DevToolsButton size="xs">Refresh</DevToolsButton>
            <DevToolsButton size="xs">Clear</DevToolsButton>
            <DevToolsButton size="xs" variant="primary">
              Export
            </DevToolsButton>
          </div>

          <div className="flex items-center space-x-2">
            <span className="text-devtools-text-secondary text-sm">Debug actions:</span>
            <DevToolsButton size="xs" variant="danger">
              Reset all data
            </DevToolsButton>
            <DevToolsButton size="xs">Rematerialize from eventlog</DevToolsButton>
          </div>
        </div>
      </div>

      <div className="bg-devtools-surface border border-devtools-border rounded p-4">
        <h3 className="text-devtools-text font-medium mb-4">Network Tab Style</h3>
        <div className="flex items-center space-x-2">
          <DevToolsButton size="xs">🔍 Filter</DevToolsButton>
          <DevToolsButton size="xs" variant="primary">
            ⚫ Record
          </DevToolsButton>
          <DevToolsButton size="xs">🗑️ Clear</DevToolsButton>
          <DevToolsButton size="xs">⚙️ Settings</DevToolsButton>
        </div>
      </div>
    </div>
  ),
}

// Theme comparison
export const ThemeComparison: Story = {
  render: () => (
    <div className="space-y-8">
      <div>
        <h3 className="text-devtools-text font-medium mb-4">Light Theme</h3>
        <div className="bg-white border border-gray-300 rounded p-4">
          <div className="flex flex-wrap gap-3 mb-4">
            <DevToolsButton variant="default" size="sm">
              Default
            </DevToolsButton>
            <DevToolsButton variant="primary" size="sm">
              Primary
            </DevToolsButton>
            <DevToolsButton variant="danger" size="sm">
              Danger
            </DevToolsButton>
            <DevToolsButton variant="default" size="sm" disabled>
              Disabled
            </DevToolsButton>
          </div>
          <div className="flex flex-wrap gap-3">
            <DevToolsButton variant="default" size="xs">
              Default XS
            </DevToolsButton>
            <DevToolsButton variant="primary" size="xs">
              Primary XS
            </DevToolsButton>
            <DevToolsButton variant="danger" size="xs">
              Danger XS
            </DevToolsButton>
            <DevToolsButton variant="default" size="xs" disabled>
              Disabled XS
            </DevToolsButton>
          </div>
        </div>
      </div>

      <div className="dark">
        <h3 className="text-white font-medium mb-4">Dark Theme</h3>
        <div className="bg-gray-900 border border-gray-600 rounded p-4">
          <div className="flex flex-wrap gap-3 mb-4">
            <DevToolsButton variant="default" size="sm">
              Default
            </DevToolsButton>
            <DevToolsButton variant="primary" size="sm">
              Primary
            </DevToolsButton>
            <DevToolsButton variant="danger" size="sm">
              Danger
            </DevToolsButton>
            <DevToolsButton variant="default" size="sm" disabled>
              Disabled
            </DevToolsButton>
          </div>
          <div className="flex flex-wrap gap-3">
            <DevToolsButton variant="default" size="xs">
              Default XS
            </DevToolsButton>
            <DevToolsButton variant="primary" size="xs">
              Primary XS
            </DevToolsButton>
            <DevToolsButton variant="danger" size="xs">
              Danger XS
            </DevToolsButton>
            <DevToolsButton variant="default" size="xs" disabled>
              Disabled XS
            </DevToolsButton>
          </div>
        </div>
      </div>

      <div className="text-devtools-text-secondary text-sm">
        <p>
          <strong>Note:</strong> Use the theme toggle in the DevTools to test both modes
          dynamically.
        </p>
        <p>
          Compare these buttons with Chrome DevTools &gt; Application tab &gt; Storage section
          buttons.
        </p>
      </div>
    </div>
  ),
}

// Interactive playground
export const InteractivePlayground: Story = {
  render: () => (
    <div className="space-y-6">
      <h3 className="text-devtools-text font-medium">Interactive Button Testing</h3>
      <p className="text-devtools-text-secondary text-sm">
        Test hover states, focus states, and click interactions. Compare with Chrome DevTools
        buttons.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="space-y-3">
          <h4 className="text-devtools-text text-sm font-medium">Hover States</h4>
          <div className="space-y-2">
            <DevToolsButton size="sm">Hover me (default)</DevToolsButton>
            <DevToolsButton size="sm" variant="primary">
              Hover me (primary)
            </DevToolsButton>
            <DevToolsButton size="sm" variant="danger">
              Hover me (danger)
            </DevToolsButton>
          </div>
        </div>

        <div className="space-y-3">
          <h4 className="text-devtools-text text-sm font-medium">Focus States</h4>
          <div className="space-y-2">
            <DevToolsButton size="sm">Tab to focus</DevToolsButton>
            <DevToolsButton size="sm" variant="primary">
              Tab to focus
            </DevToolsButton>
            <DevToolsButton size="sm" variant="danger">
              Tab to focus
            </DevToolsButton>
          </div>
        </div>

        <div className="space-y-3">
          <h4 className="text-devtools-text text-sm font-medium">Active States</h4>
          <div className="space-y-2">
            <DevToolsButton size="sm" onClick={() => alert('Clicked!')}>
              Click me
            </DevToolsButton>
            <DevToolsButton size="sm" variant="primary" onClick={() => alert('Primary clicked!')}>
              Click me
            </DevToolsButton>
            <DevToolsButton size="sm" variant="danger" onClick={() => alert('Danger clicked!')}>
              Click me
            </DevToolsButton>
          </div>
        </div>
      </div>
    </div>
  ),
}
