import {
  commonLabels,
  deprecatedDefaults,
  githubLabels,
  legacyMigrations,
  type LabelDef,
} from '../repos/effect-utils/genie/external.ts'

const livestoreContribAreaLabels: readonly LabelDef[] = [
  {
    name: 'area:adapter',
    color: '1d76db',
    description: 'Runtime adapters such as Node and Expo · Set: manual',
  },
  {
    name: 'area:devtools',
    color: '1d76db',
    description: 'Devtools packages and shared devtools UI code · Set: manual',
  },
  {
    name: 'area:sync',
    color: '1d76db',
    description: 'Contrib sync providers such as Electric and S2 · Set: manual',
  },
  {
    name: 'area:framework',
    color: '1d76db',
    description: 'Framework integrations such as Solid and Svelte · Set: manual',
  },
  {
    name: 'area:graphql',
    color: '1d76db',
    description: 'GraphQL integration package · Set: manual',
  },
  {
    name: 'area:cli',
    color: '1d76db',
    description: 'Contrib command-line package and related workflows · Set: manual',
  },
  {
    name: 'area:examples',
    color: '1d76db',
    description: 'Example applications and reproduction projects · Set: manual',
  },
  {
    name: 'area:release',
    color: '1d76db',
    description: 'Release automation and package publishing · Set: manual',
  },
]

export default githubLabels({
  labels: [...commonLabels, ...livestoreContribAreaLabels],
  deprecated: deprecatedDefaults,
  legacyMigrations,
})
