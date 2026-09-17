import type { ObservedEvent } from '../model.ts'
import type { TooltipContent, TooltipDetail } from './components/Tooltip.tsx'

const maximumValueLength = 180
const maximumDetails = 6

export const eventTooltipContent = (event: ObservedEvent): TooltipContent => ({
  title: humanizeEventName(event.name),
  status: event.disposition === 'pending' ? 'pending' : undefined,
  details: eventArgumentDetails(event.args),
})

export const timelineEventTooltipContent = (events: ReadonlyArray<ObservedEvent>): TooltipContent => {
  if (events.length === 1) return eventTooltipContent(events[0]!)
  const visibleEvents = events.slice(0, 5)
  const details: TooltipDetail[] = visibleEvents.map((event) => ({
    label: humanizeEventName(event.name),
    value: compactEventArguments(event.args),
  }))
  if (events.length > visibleEvents.length)
    details.push({ label: 'more', value: `${events.length - visibleEvents.length} additional events` })
  return { title: `${events.length} events`, details }
}

export const humanizeEventName = (name: string): string => {
  const unversioned = name.replace(/^v\d+\./, '')
  const spaced = unversioned
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return spaced.length === 0 ? name : `${spaced[0]!.toUpperCase()}${spaced.slice(1).toLowerCase()}`
}

export const eventArgumentDetails = (args: unknown): ReadonlyArray<TooltipDetail> => {
  if (args === null || typeof args !== 'object' || Array.isArray(args) === true)
    return [{ label: 'value', value: formatEventArgument(args) }]

  const entries = Object.entries(args)
  const visible = entries
    .slice(0, maximumDetails)
    .map(([label, value]) => ({ label, value: formatEventArgument(value) }))
  return entries.length <= maximumDetails
    ? visible
    : [...visible, { label: 'more', value: `${entries.length - maximumDetails} additional arguments` }]
}

const formatEventArgument = (value: unknown): string => {
  const formatted =
    typeof value === 'string' ? value : value === undefined ? 'undefined' : (JSON.stringify(value) ?? String(value))
  return formatted.length <= maximumValueLength ? formatted : `${formatted.slice(0, maximumValueLength - 1)}…`
}

const compactEventArguments = (args: unknown): string =>
  eventArgumentDetails(args)
    .map(({ label, value }) => `${label}: ${value}`)
    .join(' · ')
