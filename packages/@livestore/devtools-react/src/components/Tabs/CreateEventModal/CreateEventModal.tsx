import type { EventDef } from '@livestore/common/schema'
import React from 'react'
import * as RAC from 'react-aria-components'

import { useConfirmState } from '../../ConfirmModalContext.js'
import {
  buildFieldsFromAst,
  defaultValueForField,
  type FieldConfig,
  formatDateTimeInputValue,
  getValueAtPath,
  isFieldValueMissing,
  setValueAtPath,
  validateArgs,
} from './schema.js'

type CreateEventModalProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  eventDefs: ReadonlyArray<EventDef.AnyWithoutFn>
  onSubmit: (payload: { name: string; args: Record<string, unknown> }) => Promise<void>
}

export const CreateEventModal: React.FC<CreateEventModalProps> = ({
  isOpen,
  onOpenChange,
  eventDefs,
  onSubmit,
}) => {
  const sortedEventDefs = React.useMemo(
    () => [...eventDefs].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    [eventDefs],
  )
  const [selectedEventName, setSelectedEventName] = React.useState(sortedEventDefs[0]?.name ?? '')
  const selectedEventDef = React.useMemo(
    () => sortedEventDefs.find((e) => e.name === selectedEventName) ?? sortedEventDefs[0],
    [selectedEventName, sortedEventDefs],
  )

  const fields = React.useMemo(
    () => (selectedEventDef ? buildFieldsFromAst(selectedEventDef.schema.ast) : []),
    [selectedEventDef],
  )

  const initialArgs = React.useMemo(() => {
    const acc: Record<string, unknown> = {}
    for (const field of fields) {
      if (field.required || field.render === 'select') {
        Object.assign(acc, setValueAtPath(acc, field.path, defaultValueForField(field)))
      }
    }
    return acc
  }, [fields])

  const [argsState, setArgsState] = React.useState<Record<string, unknown>>({})
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const { setConfirmState } = useConfirmState()
  const [isDirty, setIsDirty] = React.useState(false)

  React.useEffect(() => {
    setArgsState(initialArgs)
    setIsDirty(false)
    setError(undefined)
  }, [selectedEventDef, initialArgs])

  const updateField = React.useCallback((path: ReadonlyArray<string>, value: unknown) => {
    setArgsState((prev) => {
      const next = setValueAtPath(prev, path, value)
      setIsDirty(true)
      return next
    })
  }, [])

  const validationResult = React.useMemo(() => {
    if (!selectedEventDef)
      return {
        ok: false,
        missing: 0,
        decoded: undefined,
        encoded: undefined,
        fieldErrors: {} as Record<string, ReadonlyArray<string>>,
      }
    return validateArgs({ fields, argsState, eventSchema: selectedEventDef.schema })
  }, [argsState, fields, selectedEventDef])

  const handleSubmit = React.useCallback(async () => {
    if (
      !selectedEventDef ||
      validationResult.ok === false ||
      validationResult.decoded === undefined
    )
      return
    setIsSubmitting(true)
    setError(undefined)
    try {
      await onSubmit({
        name: selectedEventDef.name,
        args: validationResult.decoded as Record<string, unknown>,
      })
      setIsDirty(false)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmitting(false)
    }
  }, [selectedEventDef, validationResult, onSubmit, onOpenChange])

  const requestClose = React.useCallback(() => {
    if (!isDirty) {
      onOpenChange(false)
      return
    }
    setConfirmState({
      _tag: 'Confirming',
      message: 'Discard changes?',
      confirmLabel: 'Discard',
      onConfirm: () => {
        setConfirmState({ _tag: 'None' })
        setArgsState({})
        setIsDirty(false)
        setError(undefined)
        onOpenChange(false)
      },
    })
  }, [isDirty, onOpenChange, setConfirmState])

  const handleOpenChange = (open: boolean) => {
    if (open) {
      onOpenChange(true)
    } else {
      requestClose()
    }
  }

  return (
    <RAC.ModalOverlay
      isOpen={isOpen}
      onOpenChange={handleOpenChange}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <RAC.Modal className="flex h-[90vh] w-full max-w-4xl items-stretch overflow-hidden rounded-lg border border-devtools-border bg-devtools-surface shadow-2xl outline-none">
        <RAC.Dialog className="flex h-full w-full flex-col p-4" aria-label="Create new event">
          <div className="flex items-start justify-between gap-3 border-b border-devtools-border pb-3">
            <div>
              <div className="text-base font-semibold text-devtools-text">Create event</div>
              <div className="text-xs text-devtools-text-secondary">
                Populate arguments based on the LiveStore event schema.
              </div>
            </div>
            <div className="flex items-center gap-2">
              {validationResult.ok === false && (
                <span className="text-[11px] text-devtools-text-secondary">
                  {validationResult.missing > 0
                    ? `Missing required: ${validationResult.missing}`
                    : 'Please review invalid fields'}
                </span>
              )}
              <RAC.Button
                onPress={requestClose}
                className="rounded border border-devtools-border px-2.5 py-1.5 text-xs font-medium text-devtools-text hover:bg-devtools-surface-hover"
              >
                Cancel
              </RAC.Button>
              <RAC.Button
                onPress={handleSubmit}
                isDisabled={isSubmitting || !selectedEventDef || validationResult.ok === false}
                className="rounded border border-devtools-border bg-devtools-text px-3 py-1.5 text-xs font-semibold text-devtools-surface hover:bg-devtools-text/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? 'Creating...' : 'Create event'}
              </RAC.Button>
            </div>
          </div>

          <div className="mt-4 flex flex-1 min-h-0 gap-4">
            <div className="w-60 flex-shrink-0 overflow-y-auto rounded-md border border-devtools-border bg-devtools-surface-secondary">
              <EventList
                events={sortedEventDefs}
                selectedEventName={selectedEventDef?.name}
                onSelect={setSelectedEventName}
              />
            </div>
            <div className="flex-1 basis-0 min-h-0 overflow-y-auto">
              <div className="flex h-full flex-col gap-4 pr-1">
                {selectedEventDef === undefined ? (
                  <div className="rounded-md border border-devtools-border bg-devtools-surface-secondary px-3 py-3 text-sm text-devtools-text">
                    No event definitions available for this schema.
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col gap-3">
                      {fields.map((field) => (
                        <FieldRow
                          key={field.path.join('.')}
                          field={field}
                          errors={validationResult.fieldErrors[field.path.join('.')] ?? []}
                          value={getValueAtPath(argsState, field.path)}
                          isOptional={!field.required}
                          onChange={(val) => updateField(field.path, val)}
                          onClear={() => updateField(field.path, undefined)}
                        />
                      ))}
                    </div>
                    {error && (
                      <div className="rounded-md border border-red-500/70 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                        {error}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </RAC.Dialog>
      </RAC.Modal>
    </RAC.ModalOverlay>
  )
}

const EventList: React.FC<{
  events: ReadonlyArray<EventDef.AnyWithoutFn>
  selectedEventName: string | undefined
  onSelect: (name: string) => void
}> = ({ events, selectedEventName, onSelect }) => {
  const filterId = React.useId()
  const [filter, setFilter] = React.useState('')
  const normalizedFilter = filter.trim().toLowerCase()
  const filteredEvents = React.useMemo(
    () =>
      normalizedFilter === ''
        ? events
        : events.filter((e) => e.name.toLowerCase().includes(normalizedFilter)),
    [events, normalizedFilter],
  )
  const synced = filteredEvents.filter((e) => e.options.clientOnly === false)
  const clientOnly = filteredEvents.filter((e) => e.options.clientOnly === true)
  const renderGroup = (label: string, group: ReadonlyArray<EventDef.AnyWithoutFn>) => {
    if (group.length === 0) return null
    return (
      <div className="py-1">
        <div className="px-3 py-1 text-[11px] font-semibold uppercase text-devtools-text-secondary">
          {label}
        </div>
        <div className="flex flex-col">
          {group.map((event) => {
            const isActive = event.name === selectedEventName
            return (
              <button
                key={event.name}
                type="button"
                onClick={() => onSelect(event.name)}
                className={`w-full px-3 py-2 text-left text-sm transition ${
                  isActive
                    ? 'bg-devtools-focus/15 text-devtools-text'
                    : 'text-devtools-text-secondary hover:bg-devtools-surface-hover hover:text-devtools-text'
                }`}
              >
                <div className="flex items-center justify-between gap-2 text-[12px] leading-tight whitespace-normal break-words">
                  <span className="font-medium">{event.name}</span>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 border-b border-devtools-border bg-devtools-surface-secondary px-2 py-2">
        <label className="sr-only" htmlFor={filterId}>
          Filter events
        </label>
        <input
          id={filterId}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter events"
          className="w-full rounded-md border border-devtools-border/60 bg-devtools-surface px-2 py-1 text-xs text-devtools-text placeholder:text-devtools-text-secondary focus:border-devtools-focus focus:outline-none"
        />
      </div>
      {filteredEvents.length === 0 ? (
        <div className="px-3 py-3 text-sm text-devtools-text-secondary">
          No events match that filter.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-devtools-border/60">
          {renderGroup('Synced', synced)}
          {renderGroup('Client-only', clientOnly)}
        </div>
      )}
    </div>
  )
}

const FieldRow: React.FC<{
  field: FieldConfig
  value: unknown
  helper?: string
  isOptional: boolean
  errors: ReadonlyArray<string>
  onChange: (value: unknown) => void
  onClear: () => void
}> = ({ field, value, helper, isOptional, errors, onChange, onClear }) => {
  const fieldId = React.useId()
  const fieldLabelId = React.useId()
  const controlRef = React.useRef<HTMLElement | null>(null)
  const isMissing = field.required && isFieldValueMissing(field, value)
  const fieldLabel = field.path.length > 0 ? field.path.join('.') : 'value'
  const depth = Math.max(0, field.path.length - 1)

  const fieldTypeLabel =
    field.render === 'select'
      ? 'enum'
      : field.render === 'textarea'
        ? 'json'
        : field.render === 'boolean'
          ? 'boolean'
          : field.render === 'number'
            ? 'number'
            : field.render === 'datetime'
              ? 'date'
              : 'string'

  const canBeUndefined = isOptional
  const isPresent = !canBeUndefined || value !== undefined

  const ensurePresentDefault = () => {
    if (isPresent) return
    onChange(defaultValueForField(field))
  }

  const togglePresence = () => {
    if (!canBeUndefined) return
    if (isPresent) {
      onClear()
    } else {
      ensurePresentDefault()
    }
  }

  const focusControl = () => controlRef.current?.focus()

  const indicatorClass =
    canBeUndefined === false
      ? isMissing
        ? 'border-amber-500 bg-amber-500/30'
        : 'border-devtools-focus bg-devtools-focus/40'
      : isPresent
        ? isMissing
          ? 'border-amber-500 bg-amber-500/30'
          : 'border-devtools-focus bg-devtools-focus/40'
        : 'border-devtools-border bg-devtools-surface'

  const errorText = errors[0]
  const ErrorText = errorText ? (
    <div className="pt-0.5 text-[11px] leading-tight text-red-300 text-right">{errorText}</div>
  ) : null

  const LeftColumn = (
    <div
      className="flex min-w-[200px] max-w-[45%] shrink-0 items-center gap-2 text-left"
      style={{ paddingLeft: depth === 0 ? 0 : depth * 8 }}
    >
      <label className="mt-[2px] flex items-center text-[11px] text-devtools-text-secondary">
        <input
          type="checkbox"
          checked={canBeUndefined ? isPresent : true}
          onChange={togglePresence}
          disabled={!canBeUndefined}
          className={`h-3 w-3 rounded text-devtools-focus outline-none focus:ring-1 focus:ring-devtools-focus disabled:opacity-60 ${indicatorClass}`}
        />
      </label>
      <button
        type="button"
        onClick={() => {
          if (canBeUndefined && isPresent === false) togglePresence()
          focusControl()
        }}
        aria-controls={fieldId}
        aria-labelledby={fieldLabelId}
        className="flex-1 cursor-pointer text-left"
      >
        <div className="flex items-baseline gap-2">
          <span id={fieldLabelId} className="text-sm font-medium text-devtools-text">
            {fieldLabel}
          </span>
          <span className="text-[11px] leading-tight text-devtools-text-secondary">
            ({fieldTypeLabel})
          </span>
        </div>
        {helper && (
          <div className="text-[11px] leading-tight text-devtools-text-secondary">{helper}</div>
        )}
      </button>
    </div>
  )

  if (field.render === 'boolean') {
    return (
      <label className="flex w-full items-center gap-4 py-1.5">
        {LeftColumn}
        <div className="flex flex-1 flex-col items-end gap-1">
          <input
            type="checkbox"
            id={fieldId}
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            disabled={!isPresent}
            className={`h-4 w-4 rounded text-devtools-focus outline-none focus:ring-2 focus:ring-devtools-focus disabled:opacity-60 ${indicatorClass}`}
            ref={(el) => {
              controlRef.current = el
            }}
          />
          {ErrorText}
        </div>
      </label>
    )
  }

  if (field.render === 'select' && field.options !== undefined) {
    const options = field.options ?? []
    const selectedKey = isPresent
      ? String((value as string | number | boolean | null | undefined) ?? options[0]?.value ?? '')
      : options[0] !== undefined
        ? String(options[0].value)
        : undefined
    return (
      <RAC.Select
        selectedKey={selectedKey ?? null}
        onSelectionChange={(key) => onChange(key as string | number | boolean)}
        className="flex w-full items-center gap-4 py-1.5 text-devtools-text"
        isDisabled={!isPresent}
      >
        <RAC.Label className="sr-only">{fieldLabel}</RAC.Label>
        {LeftColumn}
        <div className="flex-1">
          <RAC.Button
            id={fieldId}
            aria-labelledby={fieldLabelId}
            ref={(el) => {
              controlRef.current = el
            }}
            className="flex w-full items-center justify-between rounded-md border border-devtools-border bg-devtools-surface px-2 py-1 text-left text-sm hover:border-devtools-focus"
          >
            <RAC.SelectValue />
            <span aria-hidden="true" className="text-devtools-text-secondary">
              ▾
            </span>
          </RAC.Button>
          <RAC.Popover className="border border-devtools-border bg-devtools-surface rounded-md shadow-lg">
            <RAC.ListBox className="py-1 text-sm">
              {options.map((option) => (
                <RAC.ListBoxItem
                  id={String(option.value)}
                  key={String(option.value)}
                  className="cursor-pointer px-3 py-2 text-devtools-text hover:bg-devtools-surface-hover"
                >
                  {option.label}
                </RAC.ListBoxItem>
              ))}
            </RAC.ListBox>
          </RAC.Popover>
          {ErrorText}
        </div>
      </RAC.Select>
    )
  }

  if (field.render === 'textarea') {
    const textValue = isPresent
      ? typeof value === 'string'
        ? value
        : value
          ? JSON.stringify(value, null, 2)
          : ''
      : ''
    return (
      <RAC.TextField
        value={textValue}
        onChange={(next) => onChange(next)}
        className="flex w-full items-start gap-4 py-1.5 text-sm text-devtools-text"
      >
        <RAC.Label className="sr-only">{fieldLabel}</RAC.Label>
        {LeftColumn}
        <div className="flex-1">
          <RAC.TextArea
            id={fieldId}
            aria-labelledby={fieldLabelId}
            disabled={!isPresent}
            ref={(el) => {
              controlRef.current = el
            }}
            className="w-full min-h-[96px] resize-y rounded-md border border-devtools-border bg-devtools-surface px-2 py-2 text-sm text-devtools-text focus:border-devtools-focus focus:outline-none disabled:opacity-60"
          />
          {ErrorText}
        </div>
      </RAC.TextField>
    )
  }

  const inputValue =
    field.render === 'datetime'
      ? formatDateTimeInputValue(value)
      : typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : ''

  return (
    <RAC.TextField
      value={isPresent ? inputValue : ''}
      onChange={(next) => onChange(next)}
      type={
        field.render === 'number'
          ? 'number'
          : field.render === 'datetime'
            ? 'datetime-local'
            : 'text'
      }
      className="flex w-full items-center gap-4 py-1.5 text-sm text-devtools-text"
    >
      <RAC.Label className="sr-only">{fieldLabel}</RAC.Label>
      {LeftColumn}
      <div className="flex-1">
        <RAC.Input
          id={fieldId}
          aria-labelledby={fieldLabelId}
          disabled={!isPresent}
          ref={(el) => {
            controlRef.current = el
          }}
          className="w-full rounded-md border border-devtools-border bg-devtools-surface px-2 py-1 text-sm text-devtools-text focus:border-devtools-focus focus:outline-none disabled:opacity-60"
        />
        {ErrorText}
      </div>
    </RAC.TextField>
  )
}
