import type { SvgAttribute, SvgSceneNode, TimelineScene } from './timeline-scene.ts'

/** Serializes the shared scene for the legacy viewer without re-deriving any geometry. */
export const renderTimelineSceneMarkup = (
  scene: TimelineScene,
  ariaValueText: string,
  traceLength: number,
  cursorIndex: number,
): string => `
  <svg
    class="timeline-main"
    viewBox="0 0 ${scene.main.width} ${scene.main.height}"
    role="slider"
    tabindex="0"
    aria-label="Trace cursor"
    aria-valuemin="0"
    aria-valuemax="${traceLength - 1}"
    aria-valuenow="${Math.max(cursorIndex, 0)}"
    aria-valuetext="${escapeMarkup(ariaValueText)}"
  >
    ${renderSvgNodes(scene.main.compressedGaps)}
    ${renderSvgNodes(scene.main.connectivityBands)}
    ${renderSvgNodes(scene.main.failureBoundaries)}
    ${renderSvgNodes(scene.main.laneHierarchy)}
    ${renderSvgNodes(scene.main.laneLayer)}
    ${renderSvgNodes(scene.main.participantMilestones)}
    ${renderSvgNodes(scene.main.captureGuides)}
    ${renderSvgNodes(scene.main.eventMarkers)}
    ${renderSvgNodes(scene.main.runtimeFailures)}
    ${renderSvgNodes(scene.main.traceCarpet)}
    ${renderSvgNodes(scene.main.cursorLayer)}
  </svg>
  <svg
    class="range-navigator"
    viewBox="0 0 ${scene.range.width} ${scene.range.height}"
    role="group"
    tabindex="0"
    aria-label="Timeline visible range"
    data-range-navigator
  >
    ${renderSvgNodes(scene.range.windowLayer.slice(0, 3))}
    ${renderSvgNodes(scene.range.densityLayer)}
    ${renderSvgNodes(scene.range.conditionLayer)}
    ${renderSvgNodes(scene.range.failureLayer)}
    ${renderSvgNodes(scene.range.windowLayer.slice(3))}
    ${renderSvgNodes(scene.range.cursorLayer)}
  </svg>`

export const renderSvgNodes = (nodes: ReadonlyArray<SvgSceneNode>): string => nodes.map(renderSvgNode).join('')

const renderSvgNode = (sceneNode: SvgSceneNode): string => {
  const attrs = Object.entries(sceneNode.attrs ?? {})
    .flatMap(([key, value]) => renderAttribute(key, value))
    .join('')
  const contents = `${sceneNode.text === undefined ? '' : escapeMarkup(sceneNode.text)}${renderSvgNodes(sceneNode.children ?? [])}`
  return `<${sceneNode.tag}${attrs}>${contents}</${sceneNode.tag}>`
}

const renderAttribute = (key: string, value: SvgAttribute): ReadonlyArray<string> => {
  if (value === undefined || value === false) return []
  if (value === true) return [` ${key}`]
  return [` ${key}="${escapeMarkup(String(value))}"`]
}

const escapeMarkup = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
