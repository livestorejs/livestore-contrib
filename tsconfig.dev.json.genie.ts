import { tsconfigJson } from './genie/repo.ts'

export default tsconfigJson({
  compilerOptions: {},
  include: [],
  references: [{ path: './tests/integration' }, { path: './tests/package-common' }, { path: './tests/sync-provider' }],
})
