import type React from 'react'

import type { VersionMismatchStatus } from '../devtools-api.js'
import { ButtonSm } from './DevToolsButtons.tsx'

export type VersionMismatch = VersionMismatchStatus & { _tag: 'mismatch' }

/** Full-screen overlay displayed when DevTools and the app speak incompatible protocols. */
export const VersionMismatchOverlay: React.FC<{ versionMismatch: VersionMismatch }> = ({
  versionMismatch,
}) => {
  return (
    <div
      data-testid="version-mismatch-overlay"
      className="absolute inset-0 bg-amber-500/90 flex flex-col items-center justify-center z-[9999] space-y-4 p-4"
    >
      <div className="text-black text-lg font-semibold">
        LiveStore DevTools Compatibility Mismatch
      </div>
      <div className="text-black text-center max-w-md">
        This DevTools build cannot communicate with your app's LiveStore runtime protocol.
      </div>
      <div className="bg-black/20 rounded-lg p-4 space-y-2">
        <div className="flex items-center justify-between gap-4 text-black">
          <span className="font-medium">DevTools protocol:</span>
          <code className="bg-black/20 px-2 py-0.5 rounded">
            {versionMismatch.devtoolsProtocolVersion}
          </code>
        </div>
        <div className="flex items-center justify-between gap-4 text-black">
          <span className="font-medium">App protocol:</span>
          <code className="bg-black/20 px-2 py-0.5 rounded">
            {versionMismatch.appDevtoolsProtocolVersion ?? 'unknown'}
          </code>
        </div>
        <div className="flex items-center justify-between gap-4 text-black">
          <span className="font-medium">DevTools version:</span>
          <code className="bg-black/20 px-2 py-0.5 rounded">{versionMismatch.devtoolsVersion}</code>
        </div>
        <div className="flex items-center justify-between gap-4 text-black">
          <span className="font-medium">App version:</span>
          <code className="bg-black/20 px-2 py-0.5 rounded">{versionMismatch.appVersion}</code>
        </div>
      </div>
      <div className="text-black text-center text-sm max-w-md space-y-2">
        <p>
          Please update your app's <code className="bg-black/20 px-1 rounded">@livestore/*</code>{' '}
          packages. Package versions are shown for debugging; protocol compatibility is checked
          separately.
        </p>
      </div>
      <ButtonSm
        className="text-neutral-800 bg-white/80 hover:bg-white"
        onClick={() => window.location.reload()}
      >
        Reload
      </ButtonSm>
    </div>
  )
}
