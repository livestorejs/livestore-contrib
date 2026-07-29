import React from 'react'

type TTheme = 'light' | 'dark' | 'system'

interface TThemeContext {
  theme: TTheme
  setTheme: (theme: TTheme) => void
  isDark: boolean
}

const ThemeContext = React.createContext<TThemeContext | undefined>(undefined)

export const useTheme = (): TThemeContext => {
  const context = React.useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}

interface TThemeProviderProps {
  children: React.ReactNode
  defaultTheme?: TTheme
}

export const ThemeProvider: React.FC<TThemeProviderProps> = ({
  children,
  defaultTheme = 'system',
}) => {
  const [theme, setTheme] = React.useState<TTheme>(() => {
    if (typeof window === 'undefined') return defaultTheme

    const stored = localStorage.getItem('devtools-theme') as TTheme | null
    return stored ?? defaultTheme
  })

  const [systemPrefersDark, setSystemPrefersDark] = React.useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  React.useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches)

    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  React.useEffect(() => {
    localStorage.setItem('devtools-theme', theme)
  }, [theme])

  const isDark = React.useMemo(() => {
    if (theme === 'system') return systemPrefersDark
    return theme === 'dark'
  }, [theme, systemPrefersDark])

  React.useEffect(() => {
    const root = document.documentElement
    if (isDark) {
      root.classList.add('dark', 'theme-with-dark-background')
    } else {
      root.classList.remove('dark', 'theme-with-dark-background')
    }
    root.classList.add('baseline-default')
  }, [isDark])

  const value = React.useMemo(
    () => ({
      theme,
      setTheme,
      isDark,
    }),
    [theme, isDark],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
