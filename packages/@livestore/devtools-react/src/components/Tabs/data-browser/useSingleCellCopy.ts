import type * as GDG from '@glideapps/glide-data-grid'
import React from 'react'

type UseSingleCellCopyParams = {
  dataEditorContainerRef: React.RefObject<HTMLElement | null>
  getCopyValue: (cell: GDG.Item) => string
}

/**
 * Handles single-cell copy interception so we can bypass GDG's CSV escaping for targeted selections.
 */
export const useSingleCellCopy = ({
  dataEditorContainerRef,
  getCopyValue,
}: UseSingleCellCopyParams) => {
  const [gridSelection, setGridSelection] = React.useState<GDG.GridSelection | undefined>(undefined)
  const gridSelectionRef = React.useRef<GDG.GridSelection | undefined>(undefined)

  React.useEffect(() => {
    gridSelectionRef.current = gridSelection
  }, [gridSelection])

  React.useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      const selection = gridSelectionRef.current
      const activeElement = document.activeElement
      if (
        selection === undefined ||
        selection.current === undefined ||
        selection.current.range.width !== 1 ||
        selection.current.range.height !== 1 ||
        dataEditorContainerRef.current === null ||
        (activeElement !== null && !dataEditorContainerRef.current.contains(activeElement))
      ) {
        return
      }

      const { x, y } = selection.current.range
      const copyValue = getCopyValue([x, y])

      event.preventDefault()
      event.stopPropagation()
      event.clipboardData?.setData('text/plain', copyValue)
      event.clipboardData?.setData('text/html', copyValue)
    }

    window.addEventListener('copy', handleCopy, true)
    return () => {
      window.removeEventListener('copy', handleCopy, true)
    }
  }, [getCopyValue, dataEditorContainerRef])

  return { gridSelection, setGridSelection }
}
