import { githubRepositorySettings } from '../genie/repo.ts'

export default githubRepositorySettings({
  allow_auto_merge: true,
  delete_branch_on_merge: true,
})
