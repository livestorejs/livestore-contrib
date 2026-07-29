import type React from 'react'
import type { FallbackProps } from 'react-error-boundary'

export const ErrorFallback: React.FC<FallbackProps> = ({ error, resetErrorBoundary }) => (
  <div role="alert" className="space-y-3 bg-red-500 p-4 text-sm h-full overflow-y-auto">
    <div className="text-lg">Something went wrong - this should never happen:</div>
    <pre>{error.message}</pre>
    <pre>{error.stack}</pre>
    <button type="button" onClick={resetErrorBoundary}>
      Try again
    </button>
  </div>
)
