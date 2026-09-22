import { tsconfigJson } from './genie/repo.ts'
import { rootTsconfigProjects } from './genie/tsconfig-projects.ts'
import { isTsconfigReferenceTarget } from './repos/effect-utils/packages/@overeng/genie/src/runtime/composition/mod.ts'

export default tsconfigJson({
  files: [],
  references: rootTsconfigProjects
    .filter((project) => isTsconfigReferenceTarget(project.tsconfig.data))
    .map((project) => ({ path: `./${project.path}` }))
    .toSorted((a, b) => a.path.localeCompare(b.path)),
})
