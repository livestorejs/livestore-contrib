import { catalog as coreCatalog, defineCatalog, type WorkspaceIdentity } from './repo.ts'
import { contribPackageNames } from './internal.ts'

export const livestoreContribWorkspaceCatalog = Object.fromEntries(
  contribPackageNames.map((name) => [`@livestore/${name}`, 'workspace:*']),
) as Record<`@livestore/${(typeof contribPackageNames)[number]}`, 'workspace:*'>

export const livestoreContribOnlyCatalog = {} as const

export const catalog = defineCatalog({
  extends: coreCatalog,
  packages: {
    ...livestoreContribWorkspaceCatalog,
    ...livestoreContribOnlyCatalog,
  },
})

export const contribWorkspaceMember = (memberPath: string): WorkspaceIdentity => ({
  repoName: 'livestore-contrib',
  memberPath,
})
