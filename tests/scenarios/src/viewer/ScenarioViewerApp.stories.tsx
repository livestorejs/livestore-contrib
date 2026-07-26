/* eslint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Story render functions intentionally construct isolated examples. */
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'

import { ScenarioViewerApp } from './ScenarioViewerApp.tsx'
import { ReferenceFixture } from './stories/fixtures.tsx'

const meta = {
  title: 'Viewer/ScenarioViewerApp',
  component: ScenarioViewerApp,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ScenarioViewerApp>

export default meta
type Story = StoryObj<typeof meta>

export const Unloaded: Story = { args: { hidePicker: true } }

export const OfflineWriterFailure: Story = {
  render: () => (
    <ReferenceFixture name="reference-offline-writer-recovery-browser-failure.json.gz">
      {(artifact) => <ScenarioViewerApp initialArtifact={artifact} hidePicker />}
    </ReferenceFixture>
  ),
}

export const BrowserMultiSessionSuccess: Story = {
  render: () => (
    <ReferenceFixture name="reference-browser-multi-session-recovery-browser.json.gz">
      {(artifact) => <ScenarioViewerApp initialArtifact={artifact} hidePicker />}
    </ReferenceFixture>
  ),
}

export const OfflineWriterMidCursor: Story = {
  render: () => (
    <ReferenceFixture name="reference-offline-writer-recovery-browser-failure.json.gz">
      {(artifact) => (
        <ScenarioViewerApp
          initialArtifact={artifact}
          initialState={{ cursorIndex: Math.floor(artifact.trace.length / 2) }}
          hidePicker
        />
      )}
    </ReferenceFixture>
  ),
}

export const DenseSharedTodoFailure: Story = {
  render: () => (
    <ReferenceFixture name="reference-shared-todo-workday-browser-failure.json.gz">
      {(artifact) => <ScenarioViewerApp initialArtifact={artifact} hidePicker />}
    </ReferenceFixture>
  ),
}

export const NarrowViewport: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  render: () => (
    <ReferenceFixture name="reference-offline-writer-recovery-browser-failure.json.gz">
      {(artifact) => <ScenarioViewerApp initialArtifact={artifact} hidePicker />}
    </ReferenceFixture>
  ),
}

export const InteractionWorkbench: Story = {
  render: () => (
    <ReferenceFixture name="reference-offline-writer-recovery-browser-failure.json.gz">
      {(artifact) => <ScenarioViewerApp initialArtifact={artifact} hidePicker />}
    </ReferenceFixture>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText('offline-writer-recovery')
    await userEvent.click(canvas.getByRole('button', { name: 'time' }))
    await userEvent.click(canvas.getByRole('button', { name: 'raw' }))
    await expect(canvas.getByText(/Raw calibrated elapsed time/)).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'all' }))
    await expect(canvas.getByText(/records/)).toBeVisible()
    const eventButton = canvas.getAllByRole('button').find((button) => /^e\d+'?$/.test(button.textContent ?? ''))
    if (eventButton !== undefined) {
      await userEvent.click(eventButton)
      await expect(canvas.getByText(/Highlighting inferred correlation/)).toBeVisible()
    }
    await userEvent.click(canvas.getByText('Trace metadata'))
    await expect(canvas.getByText('Logical time')).toBeVisible()
  },
}
