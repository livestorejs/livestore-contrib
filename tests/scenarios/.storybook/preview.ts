import type { Preview } from '@storybook/react-vite'

import '../src/viewer/style.css'

const preview: Preview = {
  parameters: {
    a11y: { test: 'error' },
    controls: { expanded: true },
    layout: 'fullscreen',
  },
}

export default preview
