import { liveStoreVersion } from '@livestore/common'
import type { Meta, StoryObj } from '@storybook/react'

import { VersionMismatchOverlay } from './VersionMismatchOverlay.js'

const meta: Meta<typeof VersionMismatchOverlay> = {
  title: 'Components/VersionMismatchOverlay',
  component: VersionMismatchOverlay,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="relative w-full h-screen bg-devtools-bg">
        <Story />
      </div>
    ),
  ],
}

export default meta

type Story = StoryObj<typeof meta>

/** Overlay when DevTools version is newer than app */
export const DevToolsNewer: Story = {
  args: {
    versionMismatch: {
      _tag: 'mismatch',
      devtoolsVersion: liveStoreVersion,
      appVersion: '0.4.0-dev.20',
      devtoolsProtocolVersion: 2,
      appDevtoolsProtocolVersion: 1,
    },
  },
}

/** Overlay when app version is newer than DevTools */
export const AppNewer: Story = {
  args: {
    versionMismatch: {
      _tag: 'mismatch',
      devtoolsVersion: '0.3.0',
      appVersion: liveStoreVersion,
      devtoolsProtocolVersion: 1,
      appDevtoolsProtocolVersion: 2,
    },
  },
}

/** Overlay with major version difference */
export const MajorVersionDifference: Story = {
  args: {
    versionMismatch: {
      _tag: 'mismatch',
      devtoolsVersion: '1.0.0',
      appVersion: '0.4.0-dev.21',
      devtoolsProtocolVersion: 3,
    },
  },
}
