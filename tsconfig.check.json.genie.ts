import { tsconfigJson } from './genie/repo.ts'
import { rootTsconfigProjects } from './genie/tsconfig-projects.ts'

export default tsconfigJson({
  files: [],
  references: rootTsconfigProjects
    .map((project) => ({ path: `./${project.path}` }))
    .toSorted((a, b) => a.path.localeCompare(b.path)),
})
