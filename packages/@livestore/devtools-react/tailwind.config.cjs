const plugin = require('tailwindcss/plugin')

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Chrome DevTools color scheme
        devtools: {
          background: 'var(--devtools-background)',
          'background-secondary': 'var(--devtools-background-secondary)',
          'background-tertiary': 'var(--devtools-background-tertiary)',
          text: 'var(--devtools-text)',
          'text-secondary': 'var(--devtools-text-secondary)',
          'text-selected': 'var(--devtools-text-selected)',
          'icon-selected': 'var(--devtools-icon-selected)',
          'bar-selected': 'var(--devtools-bar-selected)',
          'bar-hover': 'var(--devtools-bar-hover)',
          'background-hover': 'var(--devtools-background-hover)',
          divider: 'var(--devtools-divider)',
          border: 'var(--devtools-border)',
          focus: 'var(--devtools-focus)',
          surface: 'var(--devtools-surface)',
          'surface-variant': 'var(--devtools-surface-variant)',
        },
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': {
          // Chrome DevTools Light theme - using official system colors
          '--devtools-background': 'var(--sys-color-cdt-base-container)',
          '--devtools-background-secondary': 'var(--sys-color-surface-variant)',
          '--devtools-background-tertiary': 'var(--sys-color-surface1)',
          '--devtools-text': 'var(--sys-color-on-surface)',
          '--devtools-text-secondary': 'var(--sys-color-on-surface-secondary)',
          '--devtools-text-selected': 'var(--sys-color-primary)',
          '--devtools-icon-selected': 'var(--sys-color-primary)',
          '--devtools-bar-selected': 'var(--sys-color-tonal-container)',
          '--devtools-bar-hover': 'var(--sys-color-state-hover-on-subtle)',
          '--devtools-background-hover': 'var(--sys-color-state-hover-on-subtle)',
          '--devtools-divider': 'var(--sys-color-divider)',
          '--devtools-border': 'var(--sys-color-outline)',
          '--devtools-focus': 'var(--sys-color-state-focus-ring)',
          '--devtools-surface': 'var(--sys-color-surface)',
          '--devtools-surface-variant': 'var(--sys-color-surface-variant)',
        },
        '.dark': {
          // Chrome DevTools Dark theme - using official system colors
          '--devtools-background': 'var(--sys-color-cdt-base-container)',
          '--devtools-background-secondary': 'var(--sys-color-surface-variant)',
          '--devtools-background-tertiary': 'var(--sys-color-surface1)',
          '--devtools-text': 'var(--sys-color-on-surface)',
          '--devtools-text-secondary': 'var(--sys-color-on-surface-secondary)',
          '--devtools-text-selected': 'var(--sys-color-primary)',
          '--devtools-icon-selected': 'var(--sys-color-primary)',
          '--devtools-bar-selected': 'var(--sys-color-tonal-container)',
          '--devtools-bar-hover': 'var(--sys-color-state-hover-on-subtle)',
          '--devtools-background-hover': 'var(--sys-color-state-hover-on-subtle)',
          '--devtools-divider': 'var(--sys-color-divider)',
          '--devtools-border': 'var(--sys-color-outline)',
          '--devtools-focus': 'var(--sys-color-state-focus-ring)',
          '--devtools-surface': 'var(--sys-color-surface)',
          '--devtools-surface-variant': 'var(--sys-color-surface-variant)',
        },
      })
    }),
  ],
  variants: {},
}
