import React from 'react'
import ReactDOM from 'react-dom/client'

/**
 * This wrapper is useful when embedding the devtools in another App which might have conflicting CSS definitions.
 * It creates a shadow root for the devtools and injects the devtools CSS into it.
 */
export const ShadowRootWrapper: React.FC<{
  className?: string
  render: () => React.ReactElement
}> = ({ className, render }) => {
  const hostRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (hostRef.current === null) return

    if (import.meta.env.DEV) {
      // Needed to silence Reach CSS warnings during dev (which we're not using)
      document.body.style.setProperty('--reach-tabs', '1')
    }

    // TODO remove this once GDG has fixed the "portal issue"
    const styleGdg = document.createElement('style')
    document.head.append(styleGdg)

    void import('@glideapps/glide-data-grid/dist/index.css?inline').then((stylesGdg) => {
      styleGdg.textContent =
        stylesGdg.default +
        `
  #portal .gdg-pad {
    margin-top: -2px;
  }

	#portal .gdg-input {
    font-size: 12px;
    font-family: -apple-system, "system-ui", "avenir next", avenir, "segoe ui", "helvetica neue", helvetica, Ubuntu, noto, arial, sans-serif;
  }

	#portal .gdg-input:focus {
		box-shadow: none !important;
	}
	`
    })

    const host = hostRef.current

    // We can't use the host directly as the only way to detach a shadow root is to remove the host
    // which we can't as the host is controlled by React
    const hostInner = document.createElement('div')
    hostInner.style.setProperty('height', '100%')
    host.append(hostInner)

    const shadowRoot = hostInner.attachShadow({ mode: 'open' })

    const body = document.createElement('body')
    body.style.setProperty('background-color', 'var(--devtools-background)')
    body.style.setProperty('color', 'var(--devtools-text)')
    shadowRoot.append(body)

    // Inject the styles into the shadow DOM
    const style = document.createElement('style')
    shadowRoot.append(style)

    // NOTE we're lazy loading the styles to avoid increasing the static bundle size
    void import('../../dist/index.css?inline').then((styles) => {
      style.textContent = styles.default
    })

    // Create a div to serve as the react root container inside the shadow DOM
    const reactRootContainer = document.createElement('div')
    reactRootContainer.id = 'root'
    body.append(reactRootContainer)

    // const portalContainer = document.createElement('div')
    // portalContainer.id = 'portal'
    // shadowRoot.append(portalContainer)

    // Create a React root and render the children inside it
    const reactRoot = ReactDOM.createRoot(reactRootContainer)
    reactRoot.render(render())

    // Clean up when the component unmounts
    return () => {
      hostInner.remove()
      // TODO calling this right now might still result in a error message like:
      // "Attempted to synchronously unmount a root while React was already rendering. React cannot finish unmounting the root until the current render has completed, which may lead to a race condition."
      // More context for possible solution approaches: https://chat.openai.com/share/c3184b7b-b44c-44a0-8a6f-10a25756b0b0
      reactRoot.unmount()
      styleGdg.remove()
    }
  }, [render])

  return <div ref={hostRef} className={className} />
}
