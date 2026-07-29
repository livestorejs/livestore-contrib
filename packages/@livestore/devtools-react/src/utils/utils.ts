export { default as cn } from 'clsx'

export const recordToString = (record: Record<string, any>) => {
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ')
}
