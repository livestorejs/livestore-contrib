import type { Theme } from '@glideapps/glide-data-grid'
import React from 'react'

import { useTheme } from '../theme/mod.js'

export const useDataGridTheme = (): Partial<Theme> => {
  const { isDark } = useTheme()

  return React.useMemo((): Partial<Theme> => {
    if (isDark) {
      // Chrome DevTools Dark theme
      return {
        accentColor: '#8AB4F8',
        accentLight: '#2D2E30',
        accentFg: '#202124',

        textDark: '#E8EAED',
        textMedium: '#9AA0A6',
        textLight: '#9AA0A6',
        textHeader: '#E8EAED',
        textHeaderSelected: '#8AB4F8',
        textBubble: '#E8EAED',

        bgCell: '#202124',
        bgCellMedium: '#292A2D',
        bgHeader: '#292A2D',
        bgHeaderHasFocus: '#35363A',
        bgHeaderHovered: '#2D2E30',
        bgIconHeader: '#9AA0A6',
        fgIconHeader: '#E8EAED',
        bgBubble: '#292A2D',
        bgBubbleSelected: '#8AB4F8',
        bgSearchResult: 'rgba(138, 180, 248, 0.2)',

        borderColor: '#3C4043',
        drilldownBorder: '#3C4043',
        linkColor: '#8AB4F8',
        headerFontStyle: '11px',
        baseFontStyle: '11px',
        fontFamily: 'Menlo, monospace',

        headerBottomBorderColor: '#3C4043',
        horizontalBorderColor: '#3C4043',
      }
    }

    // Chrome DevTools Light theme
    return {
      accentColor: '#1A73E8',
      accentLight: '#F8F9FA',
      accentFg: '#FFFFFF',

      textDark: '#202124',
      textMedium: '#5F6368',
      textLight: '#5F6368',
      textHeader: '#202124',
      textHeaderSelected: '#1A73E8',
      textBubble: '#202124',

      bgCell: '#FFFFFF',
      bgCellMedium: '#F9F9F9',
      bgHeader: '#F1F3F4',
      bgHeaderHasFocus: '#E8EAED',
      bgHeaderHovered: '#F8F9FA',
      bgIconHeader: '#5F6368',
      fgIconHeader: '#202124',
      bgBubble: '#F9F9F9',
      bgBubbleSelected: '#1A73E8',
      bgSearchResult: 'rgba(26, 115, 232, 0.1)',

      borderColor: '#E8EAED',
      drilldownBorder: '#DADCE0',
      linkColor: '#1A73E8',
      headerFontStyle: '11px',
      baseFontStyle: '11px',
      fontFamily: 'Menlo, monospace',

      headerBottomBorderColor: '#E8EAED',
      horizontalBorderColor: '#E8EAED',
    }
  }, [isDark])
}

export const getThemeAwareCellColors = (isDark: boolean) => ({
  textDark: isDark ? '#E8EAED' : '#202124',
  textNull: isDark ? 'rgba(154, 160, 166, 0.6)' : 'rgba(95, 99, 104, 0.6)',
  textMutation: isDark ? '#FDD633' : '#F9AB00',
  bgMutation: isDark ? 'rgba(253, 214, 51, 0.1)' : 'rgba(249, 171, 0, 0.08)',
  bgDeleted: isDark ? 'rgba(244, 67, 54, 0.1)' : 'rgba(244, 67, 54, 0.05)',
})
