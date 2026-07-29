export type DevtoolsOptions = {
  resetPersistence?: boolean
  /**
   * Whether play a sound for certain events (e.g. on mutations)
   *
   * @default false
   */
  sound?:
    | {
        mutations?: boolean
      }
    | false
}
