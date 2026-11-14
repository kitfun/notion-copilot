// Tool calls as the agent runs them: each tool as pi runs it, its preview, the user's OK, and the
// errors that stop a question.
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ConfirmTool, ToolCallRequest, ToolSpec } from './types'

/**
 * What a call changes, in words; a broken preview must not stop the call, so it gives none. A
 * preview error that stops the question (see `stopsQuestion`) comes back as `stop`.
 */
export async function previewCall(
  tool: ToolSpec | undefined,
  args: unknown,
  signal?: AbortSignal,
): Promise<{ preview?: string; stop?: string }> {
  try {
    const preview = tool?.preview?.(args)
    if (typeof preview === 'string' || preview === undefined) return { preview }
    // Stop must not wait for a preview that looks things up.
    return {
      preview: await new Promise<string | undefined>((resolve, reject) => {
        if (signal?.aborted) return resolve(undefined)
        const onAbort = () => resolve(undefined)
        signal?.addEventListener('abort', onAbort, { once: true })
        preview.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort))
      }),
    }
  } catch (err) {
    // A preview turned away by Notion stops the question, like a tool's error would.
    const stop = stopsQuestion(err)
    if (stop) return { stop }
    console.error('Could not preview the tool call', err)
    return {}
  }
}

/**
 * The user's answer. `unasked` when there was no way to ask (no callback, or it failed) or the
 * question was stopped while waiting: the tool must not run, but the user did not say no.
 */
export function askUser(
  confirm: ConfirmTool | undefined,
  call: ToolCallRequest,
  signal?: AbortSignal,
): Promise<'allow' | 'deny' | 'unasked'> {
  if (!confirm || signal?.aborted) return Promise.resolve('unasked')
  return new Promise((resolve) => {
    const onAbort = () => resolve('unasked')
    signal?.addEventListener('abort', onAbort, { once: true })
    confirm(call)
      .then(
        (allow) => resolve(allow ? 'allow' : 'deny'),
        () => resolve('unasked'),
      )
      .finally(() => signal?.removeEventListener('abort', onAbort))
  })
}

/**
 * The reason a tool's error stops the question, if it does: a `stopsQuestion` string on the error
 * or on one of its causes (a tool may wrap the error it got).
 */
function stopsQuestion(err: unknown): string | undefined {
  const reason = causes(err).find((e) => typeof e.stopsQuestion === 'string')?.stopsQuestion
  return reason as string | undefined
}

/** The error and its causes (a tool may wrap the error it got). */
function causes(err: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let e = err; e && typeof e === 'object' && out.length < 5; e = (e as Error).cause) {
    out.push(e as Record<string, unknown>)
  }
  return out
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * Where a call gives null and the JSON Schema takes no null, as the model would write it: a required
 * argument (`text`, `pages[0].page`) or an entry of a list (`options[1]`). Follows `properties`,
 * `additionalProperties`, and `items`. An optional argument given as null is left to pi, which drops
 * it, and a null is fine wherever the schema says it is a value.
 */
function misplacedNulls(schema: unknown, value: unknown, path = ''): string[] {
  if (!isRecord(schema)) return []
  if (Array.isArray(value)) {
    const items = listItems(schema)
    return value.flatMap((item, n) => {
      const at = `${path}[${n}]`
      if (item === null) return items !== undefined && !admitsNull(items) ? [at] : []
      return misplacedNulls(items, item, at)
    })
  }
  if (!isRecord(value)) return []
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  return Object.entries(value).flatMap(([key, item]) => {
    const at = path ? `${path}.${key}` : key
    const property = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties
    if (item === null) return required.includes(key) && !admitsNull(property) ? [at] : []
    return misplacedNulls(property, item, at)
  })
}

/** What a JSON Schema says the entries of a list are: its own `items`, or those of the list branch of a union. */
function listItems(schema: Record<string, unknown>): unknown {
  if (schema.items !== undefined) return schema.items
  for (const branches of [schema.anyOf, schema.oneOf]) {
    const list = Array.isArray(branches) ? branches.find((b) => isRecord(b) && b.items !== undefined) : undefined
    if (isRecord(list)) return list.items
  }
  return undefined
}

/** Whether a JSON Schema takes null as a value: by its type, a constant, or a branch of a union. */
function admitsNull(schema: unknown): boolean {
  if (!isRecord(schema)) return false
  const { type } = schema
  if (type === 'null' || (Array.isArray(type) && type.includes('null')) || schema.const === null) return true
  return [schema.anyOf, schema.oneOf].some((branches) => Array.isArray(branches) && branches.some(admitsNull))
}

export interface Reporter {
  stop(reason: string): void
  changed(): void
  /** The tool failed with an error that has a code (a Notion error's, such as `no_access`). */
  failed(code: string): void
}

/**
 * The tool as pi runs it. Before `execute`, pi converts the model's arguments where it can (a null
 * for an optional argument is dropped, "2" becomes 2 for a number, one value becomes a list of one)
 * and checks the result against `parameters`. A call that does not fit never reaches the tool or
 * `beforeToolCall`: the model gets pi's list of what is wrong with each argument. The tool gets the
 * converted copy, which it parses itself when it is defined with `defineTool` (src/tool.ts).
 *
 * One conversion is stopped before pi makes it: a null where the schema takes none, for a required
 * argument or an entry of a list. pi would turn it into the text "null", 0, or false and run the tool
 * with that, so a page could be titled "null". Such a call is refused like any other that does not
 * fit, and the model is told where the nulls are.
 */
export function toAgentTool(spec: ToolSpec, reporter: () => Reporter): AgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    prepareArguments: (args) => {
      const nulls = misplacedNulls(spec.parameters, args)
      if (nulls.length) {
        throw new Error(
          `Not run: null is not a value for ${nulls.map((path) => `\`${path}\``).join(', ')}. ` +
            'Give the call again with a value there, or ask the user for one.',
        )
      }
      return args
    },
    execute: async (_id, params, signal) => {
      const report = reporter()
      let result: unknown
      try {
        result = await spec.run(params, signal)
      } catch (err) {
        const reason = stopsQuestion(err)
        if (reason) report.stop(reason)
        // An error that says data may have changed counts on its own, flag or not.
        if (causes(err).some((e) => e.mayHaveChanged === true)) report.changed()
        const code = causes(err).find((e) => typeof e.code === 'string')?.code
        if (typeof code === 'string') report.failed(code)
        throw err
      }
      if (spec.changesData) report.changed()
      // JSON.stringify(undefined) is undefined; tool results must be strings.
      const text = typeof result === 'string' ? result : (JSON.stringify(result) ?? '')
      return { content: [{ type: 'text', text }], details: undefined }
    },
  }
}
