export const getStoreId = () => {
  const searchParams = new URLSearchParams(globalThis.location?.search)
  return searchParams.get('storeId') ?? 'kanban-demo'
}