import type { ApplicationCommand, ApplicationCommandChange, ApplicationCommandsDiff } from './model.ts'
import { commandKey } from './model.ts'

/** Compares semantic command state while ignoring Discord-owned IDs and versions. */
export const diffApplicationCommands = (
  desired: ReadonlyArray<ApplicationCommand>,
  actual: ReadonlyArray<ApplicationCommand>,
): ApplicationCommandsDiff => {
  const desiredByKey = indexCommands(desired)
  const actualByKey = indexCommands(actual)
  const keys = [...new Set([...desiredByKey.commands.keys(), ...actualByKey.commands.keys()])].toSorted((left, right) =>
    left.localeCompare(right),
  )

  const changes: Array<ApplicationCommandChange> = keys.map((key) => {
    const desiredCommand = desiredByKey.commands.get(key)
    const actualCommand = actualByKey.commands.get(key)
    if (desiredCommand === undefined) return { kind: 'delete', key, actual: actualCommand! }
    if (actualCommand === undefined) return { kind: 'create', key, desired: desiredCommand }
    const equal = commandsEqual(desiredCommand, actualCommand)
    return equal === true
      ? { kind: 'unchanged', key, desired: desiredCommand, actual: actualCommand }
      : { kind: 'update', key, desired: desiredCommand, actual: actualCommand }
  })

  const duplicateActualKeys = [...actualByKey.duplicates].toSorted((left, right) => left.localeCompare(right))
  return {
    changes,
    duplicateActualKeys,
    hasChanges: duplicateActualKeys.length > 0 || changes.some((change) => change.kind !== 'unchanged'),
  }
}

const indexCommands = (commands: ReadonlyArray<ApplicationCommand>) => {
  const indexed = new Map<string, ApplicationCommand>()
  const duplicates = new Set<string>()
  for (const command of commands) {
    const key = commandKey(command)
    if (indexed.has(key) === true) duplicates.add(key)
    else indexed.set(key, command)
  }
  return { commands: indexed, duplicates }
}

const commandsEqual = (left: ApplicationCommand, right: ApplicationCommand) =>
  left.type === right.type &&
  left.name === right.name &&
  left.description === right.description &&
  left.defaultMemberPermissions === right.defaultMemberPermissions &&
  left.nsfw === right.nsfw &&
  setsEqual(left.integrationTypes, right.integrationTypes) &&
  setsEqual(left.contexts, right.contexts) &&
  left.options.length === right.options.length &&
  left.options.every((option, index) => {
    const other = right.options[index]
    return (
      other !== undefined &&
      option.type === other.type &&
      option.name === other.name &&
      option.description === other.description &&
      option.required === other.required &&
      (option.autocomplete ?? false) === (other.autocomplete ?? false) &&
      option.minLength === other.minLength &&
      option.maxLength === other.maxLength &&
      (option.choices ?? []).length === (other.choices ?? []).length &&
      (option.choices ?? []).every((choice, choiceIndex) => {
        const otherChoice = (other.choices ?? [])[choiceIndex]
        return otherChoice !== undefined && choice.name === otherChoice.name && choice.value === otherChoice.value
      })
    )
  })

const setsEqual = <TValue extends number>(
  left: ReadonlyArray<TValue> | undefined,
  right: ReadonlyArray<TValue> | undefined,
) => {
  if (left === undefined || right === undefined) return left === right
  return left.length === right.length && left.every((value) => right.includes(value))
}
