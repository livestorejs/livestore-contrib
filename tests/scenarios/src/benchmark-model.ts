/** A campaign is separate from immutable run artifacts; warmups are retained but excluded from comparisons. */
export interface BenchmarkManifest {
  readonly version: 1
  readonly id: string
  readonly startedAt: string
  status: 'running' | 'complete' | 'interrupted'
  readonly baseline: string
  readonly candidate: string
  readonly environment: {
    readonly node: string
    readonly platform: string
    readonly arch: string
    readonly cpu: string
    readonly release: string
    readonly lockHash: string
    readonly harnessHash: string
  }
  readonly samples: BenchmarkSample[]
  error?: string
}
export interface BenchmarkSample {
  readonly role: 'baseline' | 'candidate'
  readonly phase: 'warmup' | 'measured'
  readonly iteration: number
  readonly scenario: string
  readonly profile: string
  readonly file: string
  readonly exitCode: number
  /** Present when the sample had to be retried after it stalled past `--sample-timeout`. */
  readonly attempts?: number
}
export interface BenchmarkMembership {
  readonly id: string
  readonly role: 'baseline' | 'candidate'
  readonly iteration: number
  readonly complete: boolean
}
