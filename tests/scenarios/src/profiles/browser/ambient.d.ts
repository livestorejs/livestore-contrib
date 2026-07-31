declare module '*?worker' {
  const WorkerConstructor: new (options?: { name?: string }) => Worker
  export default WorkerConstructor
}

declare module '*?sharedworker' {
  const SharedWorkerConstructor: new (options?: { name?: string }) => SharedWorker
  export default SharedWorkerConstructor
}
