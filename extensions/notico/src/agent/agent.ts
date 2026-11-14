// The side panel's agent: asks the model, runs the tools it calls in the extension, and sends the
// results back until the model answers. Where the model runs is a provider (see ModelProvider in
// provider.ts): our worker (the hosted one, worker.ts), or OpenRouter or DeepSeek with the user's own
// key (own.ts). Only the modules of this folder import the agent runtime (pi); the rest of the
// extension uses the types in types.ts, through index.ts.
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { Credits, GrantsPage, Packs, UsagePeriod } from '../credits'
import { answering, HOSTED_ONLY, type OwnSetup } from '../models'
import { askUser, previewCall, toAgentTool, type Reporter } from './calls'
import { addUsage, detailsOf, recent, textOf, usedTools } from './history'
import { ownProvider } from './own'
import type { CallCost, Failure, ModelProvider } from './provider'
import { writeTitle } from './title'
import type {
  AgentConfig,
  AgentUpdate,
  AnsweredBy,
  AskResult,
  AssistantPart,
  ConfirmTool,
  HistoryMessage,
  QuestionCost,
  QuestionDetails,
  QuestionExtras,
  QuestionPage,
  TokenUsage,
  ToolCallRequest,
  ToolSpec,
  ToolStatus,
} from './types'
import { checkout, hostedProvider, readOwn } from './worker'

const DEFAULT_MAX_STEPS = 10

/**
 * How far the user's clock is ahead of UTC, in minutes: the worker totals usage per day, and a day
 * should be the user's own.
 */
const utcOffset = () => String(-new Date().getTimezoneOffset())
// What the model gets back for a call the user declined; it should not just try again.
const DECLINED = 'Not run: the user declined this action. Do not retry it; ask the user how to proceed instead.'
// The same when there was nobody to ask: the model must not claim the user said no.
const UNASKED = "Not run: this action needs the user's confirmation, and they could not be asked."
/** Added for the user when a question stops after a tool changed something, or may have. */
export const MAY_HAVE_CHANGED = 'Some changes in this question may already have been made: check before asking again.'
/** For the model: the reason itself is in the failed tool's result. */
const STOPPED_BY_ERROR = "Not run: an earlier tool's error stopped the question."
/** For the model, when the question stopped while this call, or an earlier one, was being prepared. */
function stoppedInPreview(reason: string, earlier: boolean): string {
  const which = earlier ? 'an earlier action' : 'this action'
  return `Not run: the question stopped while ${which} was being prepared. The user was told: ${reason}`
}
// What the model gets back for a call the user stopped: whether it may have done something matters
// for a tool that changes a page.
const STOPPED_BEFORE = 'Not run: the user stopped the question before this action started.'
const STOPPED_DURING =
  'Stopped by the user while this action was running; it may have partly happened. Check before trying it again.'
/** Ahead of a question asked in Read only, for the model: it has no tool that changes data for it. */
const READ_ONLY_NOTE =
  '[Read only: the user set Notico to Read only for this question, so you have no tools that change Notion. ' +
  "If the question asks for a change, make none and don't describe one as done: say you can't make changes in " +
  'Read only, and that the user can switch to Edit with the mode button at the bottom left of the message box ' +
  'and ask again. You can still read and answer.]'
/** Ahead of a question asked in Edit right after one in Read only: the tools that change data are back. */
const EDIT_NOTE = '[Edit: the user switched Notico back to Edit, so the tools that change Notion are available again.]'

export class CopilotAgent {
  private agent?: Agent
  private model?: Model<'openai-completions'>
  /** Where model requests go, and the settings it was made from. */
  private provider: ModelProvider
  private providerFor?: OwnSetup | 'hosted'
  private readonly maxSteps: number
  /** Names of the tools that need the user's OK before each run. */
  private readonly confirmed: Set<string>
  private readonly tools: Map<string, ToolSpec>
  /** The tools as the agent runtime takes them: every one in Edit, and those that change no data in Read only. */
  private readonly allTools: AgentTool[]
  private readonly readingTools: AgentTool[]
  /** Bumped by stop() and reset(), so a question still waiting to start knows it was cancelled. */
  private epoch = 0
  /** Aborted with each epoch bump, so waits that pi doesn't cut short end too. */
  private cancel = new AbortController()
  /** The question this agent is answering; reset() clears it, since the next one gets a new pi agent. */
  private running?: object
  /** The conversation to start from, used when the next pi agent is set up. */
  private initial: HistoryMessage[] = []
  /** How each tool call ended, by its result message; pi itself only knows whether it failed. */
  private readonly statuses = new WeakMap<AgentMessage, ToolStatus>()
  /** What went with each question, by its user message; see QuestionExtras. */
  private readonly contexts = new WeakMap<AgentMessage, string>()
  private readonly pages = new WeakMap<AgentMessage, QuestionPage[]>()
  private readonly readOnly = new WeakSet<AgentMessage>()
  /** What each question used, by its user message; see QuestionDetails. */
  private readonly details = new WeakMap<AgentMessage, QuestionDetails>()
  /** Set by a tool whose error stops the question (see `stopsQuestion` in calls.ts): what the user is told. */
  private stopReason?: string
  /** Set by a tool that changes data and changed something, or may have (see `changesData`). */
  private changed = false
  /** Set by a tool that failed with an error that has a code, until its call is reported as ended. */
  private failedWith?: string
  /** The model calls the latest question took; see `rounds`. */
  private steps = 0
  /** Takes each chunk of the model's streams while a question runs: what the calls cost is in them. */
  private onChunk?: (chunk: unknown) => void

  constructor(private readonly config: AgentConfig) {
    this.provider = hostedProvider(config)
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS
    this.confirmed = new Set(config.tools.filter((t) => t.needsConfirmation).map((t) => t.name))
    this.tools = new Map(config.tools.map((t) => [t.name, t]))
    this.allTools = config.tools.map((t) => toAgentTool(t, () => this.reporter()))
    this.readingTools = this.allTools.filter((_, i) => !config.tools[i].changesData)
  }

  /**
   * Asks one question and resolves once the agent answered, stopped, hit the step limit, or failed.
   * The conversation carries over to the next question. A question that fails or is stopped keeps
   * only the tools it used and how they ended, so the model learns what already happened (a tool may
   * have changed a page) but never sees a half-finished reply. If it used no tool, it is dropped.
   *
   * `confirm` is asked before each run of a tool that needs confirmation. Without it, such tools
   * are declined. `extras` go with the question, and are saved with it.
   */
  async ask(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    confirm?: ConfirmTool,
    extras: QuestionExtras = {},
  ): Promise<AskResult> {
    // One question at a time: an overlapping run would roll back the other's messages.
    if (this.running) return { status: 'error', message: 'Already answering a question.' }
    const question = {}
    this.running = question
    try {
      return await this.askWithRetry(text, onUpdate, confirm, extras)
    } finally {
      if (this.running === question) this.running = undefined
    }
  }

  private async askWithRetry(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    confirm: ConfirmTool | undefined,
    extras: QuestionExtras,
  ): Promise<AskResult> {
    const epoch = this.epoch
    // Once per question: a retry below goes to the same model, whatever the user chose meanwhile.
    try {
      await this.chooseProvider()
    } catch (err) {
      return { status: 'error', message: (err as Error).message }
    }
    const { result, kept, failure } = await this.askOnce(text, onUpdate, epoch, confirm, extras)
    // The provider's model changed since this panel looked it up (for the hosted one, a deploy, which
    // refuses the request before any credits are spent), so look the model up again. Retry once if
    // the question left nothing behind; a retry runs the whole question again, so after it used a
    // tool (which is now in the conversation), ask the user to repeat it instead.
    if (failure && this.provider.modelChanged(failure) && epoch === this.epoch) {
      // What the first try sent counts even when the question goes no further.
      const counted = detailsOf(result)
      try {
        this.model = await this.provider.loadModel()
      } catch (err) {
        return { status: 'error', message: (err as Error).message, ...counted }
      }
      if (this.agent) this.agent.state.model = this.model
      // The question stays in the conversation with the tools it used, so the model can pick up
      // where it left off; asking the same question again could run those tools twice.
      if (kept) return { status: 'error', message: 'Notico was just updated. Ask it to continue.', ...counted }
      return (await this.askOnce(text, onUpdate, epoch, confirm, extras)).result
    }
    return result
  }

  /** `kept`: the question is part of the conversation now, answered or not. `failure`: why the model request failed. */
  private async askOnce(
    text: string,
    onUpdate: (update: AgentUpdate) => void,
    epoch: number,
    confirm: ConfirmTool | undefined,
    { context, pages, readOnly }: QuestionExtras,
  ): Promise<{ result: AskResult; kept: boolean; failure?: Failure }> {
    let agent: Agent
    try {
      agent = await this.getAgent()
    } catch (err) {
      return { result: { status: 'error', message: (err as Error).message }, kept: false }
    }
    // Stopped, or a new chat started, while the agent was being set up.
    if (epoch !== this.epoch) return { result: { status: 'stopped' }, kept: false }
    // Offered for this question only, and taken as the question starts: a mode switched while it runs
    // applies from the next one. pi tells the model of the change in the conversation.
    agent.state.tools = readOnly ? this.readingTools : this.allTools

    const before = agent.state.messages.length
    this.stopReason = undefined
    this.changed = false
    this.failedWith = undefined
    this.steps = 0
    let steps = 0
    let hitLimit = false
    let failure: Failure | undefined
    let stopped = false
    // The model gave its final answer; a Stop after this point is too late to drop it.
    let answered = false
    // What the model calls of this question reported they used, if any did.
    let tokens: TokenUsage | undefined
    // What they cost, summed as the worker reports each call (the hosted model only). A cost that
    // could not be read, or was estimated, leaves the sum unknown: only an exact one is shown.
    let cost: QuestionCost | undefined
    let costUnknown = false
    const provider = this.provider
    this.onChunk = (chunk) => {
      let call: CallCost | undefined
      try {
        call = provider.callCost?.(chunk)
      } catch (err) {
        console.error('Could not read what a model call cost', err)
        costUnknown = true
      }
      if (call?.estimated) costUnknown = true
      else if (call) cost = { microCredits: (cost?.microCredits ?? 0) + call.microCredits }
    }
    const refused = new Set<string>()
    const declined = new Set<string>()
    // How the latest call with each id ended, kept with its result message when that arrives.
    const ended = new Map<string, { status: ToolStatus; result: string }>()
    // Calls allowed to run, so a Stop may have cut them short; the others never started. For a tool
    // that needs the user's OK, a Stop between the OK and the run counts as started: for a tool that
    // changes pages, "may have partly happened" is the safe thing to tell the model.
    const started = new Set<string>()
    // The call running now (tools run one at a time), for a question it puts to the user.
    let running: ToolCallRequest | undefined
    // Why the question stopped, when it stopped in a call's preview rather than in a tool's run.
    let previewStop: string | undefined
    const meter = this.config.meter?.(async (text) => {
      const call = running
      if (!call || epoch !== this.epoch) return false
      const answer = await askUser(confirm, { ...call, question: text }, this.cancel.signal)
      return answer === 'allow' && epoch === this.epoch
    })

    // On the last step, refuse the tools the model asks for instead of running them: the question
    // ends here, so the model would never see their results, and a tool could change a page.
    agent.beforeToolCall = async ({ toolCall, args }, signal) => {
      // A tool's error, or an earlier call's preview, stopped the question: nothing more runs.
      if (this.stopReason) {
        refused.add(toolCall.id)
        const reason = previewStop === undefined ? STOPPED_BY_ERROR : stoppedInPreview(previewStop, true)
        return { block: true, reason, terminate: true }
      }
      if (steps >= this.maxSteps) {
        hitLimit = true
        refused.add(toolCall.id)
        return {
          block: true,
          reason: `Not run: this question reached its limit of ${this.maxSteps} steps.`,
          terminate: true,
        }
      }
      // Running from here on: a preview's lookups count toward the question, so at its request budget
      // they ask the user on this call's card.
      running = { id: toolCall.id, name: toolCall.name, args }
      // From the arguments the tool runs with, and before it runs: the run may change what the preview reads.
      const { preview, stop } = await previewCall(this.tools.get(toolCall.name), args, signal)
      // Stopped while the preview looked things up: the tool must not start.
      if (signal?.aborted || epoch !== this.epoch) {
        running = undefined
        return { block: true, reason: STOPPED_BEFORE }
      }
      // Notion turned the preview's lookups away, or the user stopped at the budget: the question
      // stops here, before anyone is asked.
      if (stop) {
        running = undefined
        this.stopReason ??= stop
        previewStop = stop
        refused.add(toolCall.id)
        return { block: true, reason: stoppedInPreview(stop, false), terminate: true }
      }
      onUpdate({ type: 'tool_ready', id: toolCall.id, args, preview })
      const call: ToolCallRequest = { id: toolCall.id, name: toolCall.name, args, preview }
      running = call
      if (!this.confirmed.has(toolCall.name)) {
        started.add(toolCall.id)
        return
      }
      const answer = await askUser(confirm, call, signal)
      if (answer === 'allow' && epoch === this.epoch) {
        started.add(toolCall.id)
        return
      }
      running = undefined
      // Only a no from the user shows as declined. Stopped while waiting shows as stopped, and a
      // prompt that could not be shown as failed, with the reason.
      if (answer === 'deny' && epoch === this.epoch) declined.add(toolCall.id)
      return { block: true, reason: answer === 'deny' ? DECLINED : UNASKED }
    }
    // The model gets no more turns once the steps are used up. beforeToolCall above only sees calls
    // that pi could prepare; unknown tools and invalid arguments get error results without it.
    agent.finishTurn = async ({ toolResults }) => {
      if (this.stopReason) return { action: 'end' }
      if (steps < this.maxSteps || toolResults.length === 0) return
      hitLimit = true
      return { action: 'end' }
    }
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === 'turn_start') this.steps = ++steps
      const update = toUpdate(event)
      if (update?.type === 'tool_end') {
        // Tools run one at a time, so a code reported since the last call ended is this call's.
        if (update.status === 'failed' && this.failedWith) update.code = this.failedWith
        this.failedWith = undefined
        if (refused.has(update.id)) update.status = 'skipped'
        else if (declined.has(update.id)) update.status = 'declined'
        // A tool cut short by Stop reports an error; it did not fail on its own. A tool that
        // finished anyway keeps its result: what it did happened.
        else if (update.status === 'failed' && epoch !== this.epoch) {
          update.status = 'stopped'
          // Tell the model whether the tool could have done anything. One that ran keeps its own
          // error too: it may have failed on its own just as Stop landed.
          update.result = started.has(update.id) ? `${STOPPED_DURING}\n${update.result}` : STOPPED_BEFORE
        }
        started.delete(update.id)
        if (running?.id === update.id) running = undefined
        ended.set(update.id, { status: update.status, result: update.result })
      }
      if (update) onUpdate(update)
      if (event.type === 'message_end' && event.message.role === 'toolResult') {
        const end = ended.get(event.message.toolCallId)
        if (end) this.statuses.set(event.message, end.status)
        // pi keeps this same message in the conversation, so the model gets the text the panel shows.
        if (end?.status === 'stopped') event.message.content = [{ type: 'text', text: end.result }]
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const m = event.message as AssistantMessage
        tokens = addUsage(tokens, m.usage)
        if (m.stopReason === 'error') failure = this.provider.parseError(m.errorMessage)
        if (m.stopReason === 'aborted') stopped = true
        const final = !m.content.some((block) => block.type === 'toolCall')
        if (final && (m.stopReason === 'stop' || m.stopReason === 'length')) answered = true
      }
    })

    // String content: the worker accepts only text, and pi would otherwise send content parts.
    const question: AgentMessage = { role: 'user', content: text, timestamp: Date.now() }
    try {
      if (context) this.contexts.set(question, context)
      if (pages?.length) this.pages.set(question, pages)
      if (readOnly) this.readOnly.add(question)
      await agent.prompt(question)
    } catch (err) {
      failure ??= this.provider.parseError((err as Error).message)
    } finally {
      unsubscribe()
      agent.beforeToolCall = undefined
      agent.finishTurn = undefined
      this.onChunk = undefined
    }
    // Also stopped when the abort landed after a model reply that asked for tools, e.g. while a tool
    // finished. A stop after the final answer keeps it: the user has already read it.
    stopped ||= epoch !== this.epoch && !answered
    // A write that was sent counts even when the tool that sent it does not say it changed data.
    const changed = this.changed || meter?.wrote === true
    if (!stopped && this.stopReason)
      failure ??= { text: changed ? `${this.stopReason} ${MAY_HAVE_CHANGED}` : this.stopReason }
    // Kept with the question, so a saved session still has it. Only a question that ended normally has
    // a cost: one stopped or failed has none, since a call cut short never hears what it was charged
    // (the balance still shows it).
    const model = this.answeredBy()
    const spent = costUnknown || stopped || failure ? undefined : cost
    const counted = detailsOf({ requests: meter?.requests, tokens, model, cost: spent })
    this.details.set(question, counted)
    if (failure || stopped) {
      const kept = usedTools(agent.state.messages.slice(before))
      agent.state.messages = [...agent.state.messages.slice(0, before), ...kept]
      const result: AskResult = stopped
        ? { status: 'stopped' }
        : { status: 'error', message: failure!.text, ...(failure!.code ? { code: failure!.code } : {}) }
      return { result: { ...result, ...counted }, kept: kept.length > 0, failure: stopped ? undefined : failure }
    }
    const result: AskResult = hitLimit ? { status: 'step_limit', steps } : { status: 'done' }
    return { result: { ...result, ...counted }, kept: true }
  }

  /** How many times the model was called for the latest question, once `ask` resolved: 0 when it never got that far. */
  rounds(): number {
    return this.steps
  }

  /** Stops the current model call and any running tool. */
  stop(): void {
    this.epoch++
    this.cancel.abort()
    this.cancel = new AbortController()
    this.agent?.abort()
  }

  /**
   * Starts another conversation: a new one, or `history` to continue a saved one. A question still
   * running is stopped first. It looks up the model again.
   */
  async reset(history: HistoryMessage[] = []): Promise<void> {
    this.epoch++
    this.cancel.abort()
    this.cancel = new AbortController()
    const agent = this.agent
    this.agent = undefined
    this.model = undefined
    this.running = undefined
    this.initial = history
    if (!agent) return
    agent.abort()
    await agent.waitForIdle()
  }

  /**
   * The conversation so far, to save and later continue with reset(). Of a question that failed or
   * was stopped, only the tools it used are part of it. Read it between questions: while one runs, it
   * is still changing.
   */
  history(): HistoryMessage[] {
    if (!this.agent) return this.initial
    return this.agent.state.messages.flatMap((m) => this.toHistory(m))
  }

  private toHistory(message: AgentMessage): HistoryMessage[] {
    switch (message.role) {
      case 'user': {
        const context = this.contexts.get(message)
        const pages = this.pages.get(message)
        return [
          {
            role: 'user',
            text: textOf(message.content),
            ...(context && { context }),
            ...(pages && { pages }),
            ...(this.readOnly.has(message) && { readOnly: true as const }),
            ...this.details.get(message),
          },
        ]
      }
      case 'assistant':
        return [
          {
            role: 'assistant',
            parts: message.content.flatMap((block): AssistantPart[] => {
              if (block.type === 'text') return [{ type: 'text', text: block.text }]
              if (block.type === 'toolCall')
                return [{ type: 'tool_call', id: block.id, name: block.name, args: block.arguments }]
              return []
            }),
          },
        ]
      case 'toolResult':
        return [
          {
            role: 'tool',
            id: message.toolCallId,
            name: message.toolName,
            status: this.statuses.get(message) ?? (message.isError ? 'failed' : 'done'),
            result: textOf(message.content),
          },
        ]
      default:
        return []
    }
  }

  private fromHistory(history: HistoryMessage[], model: Model<'openai-completions'>): AgentMessage[] {
    const timestamp = Date.now()
    return history.map((m): AgentMessage => {
      if (m.role === 'user') {
        const question: AgentMessage = { role: 'user', content: m.text, timestamp }
        if (m.context) this.contexts.set(question, m.context)
        if (m.pages?.length) this.pages.set(question, m.pages)
        if (m.readOnly) this.readOnly.add(question)
        const details = detailsOf(m)
        if (Object.keys(details).length) this.details.set(question, details)
        return question
      }
      if (m.role === 'assistant') {
        const content: AssistantMessage['content'] = m.parts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'toolCall', id: p.id, name: p.name, arguments: p.args },
        )
        return {
          role: 'assistant',
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
          stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp,
        }
      }
      const result: AgentMessage = {
        role: 'toolResult',
        toolCallId: m.id,
        toolName: m.name,
        content: [{ type: 'text', text: m.result }],
        isError: m.status !== 'done',
        timestamp,
      }
      this.statuses.set(result, m.status)
      return result
    })
  }

  /**
   * For a tool starting now: how it reports to the running question that it stops it (with a
   * reason for the user) or changed data. A tool still running from a question that was stopped
   * or reset reports nothing to the next one.
   */
  private reporter(): Reporter {
    const epoch = this.epoch
    return {
      stop: (reason) => {
        if (epoch === this.epoch) this.stopReason ??= reason
      },
      changed: () => {
        if (epoch === this.epoch) this.changed = true
      },
      failed: (code) => {
        if (epoch === this.epoch) this.failedWith = code
      },
    }
  }

  /**
   * Uses the provider the settings name now. Another one than before drops the model, so the next
   * request looks it up from the new provider; the conversation stays.
   */
  private async chooseProvider(): Promise<void> {
    const choice = answering((await this.config.model?.()) ?? HOSTED_ONLY) ?? 'hosted'
    const before = this.providerFor
    this.providerFor = choice
    // The agent starts on the hosted provider.
    if (before === undefined ? choice === 'hosted' : JSON.stringify(before) === JSON.stringify(choice)) return
    this.provider = choice === 'hosted' ? hostedProvider(this.config) : ownProvider(choice)
    this.model = undefined
  }

  /** The model the question being answered is asked of, once it has been looked up. */
  private answeredBy(): AnsweredBy | undefined {
    const used = this.providerFor
    if (used === undefined || used === 'hosted') return { service: 'hosted' }
    return this.model && { service: used.service, name: this.model.name }
  }

  private async getAgent(): Promise<Agent> {
    if (this.agent && this.model) return this.agent
    const model = (this.model ??= await this.provider.loadModel())
    // The provider changed since the agent was set up: the conversation goes on with its model.
    if (this.agent) {
      this.agent.state.model = model
      this.agent.identity = this.provider.identity
      return this.agent
    }
    // The tool definitions go with every request and count toward the provider's size limit.
    const toolChars = JSON.stringify(
      this.config.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    ).length
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.config.systemPrompt,
        model,
        tools: this.allTools,
        messages: this.fromHistory(this.initial, model),
      },
      streamFn: (m, context, options) => {
        // The question asking now: its request reports to it, even if another starts meanwhile.
        const onChunk = this.onChunk
        return streamSimple(m as Model<'openai-completions'>, context, {
          ...options,
          onProviderStreamEvent: (chunk) => onChunk?.(chunk),
        })
      },
      getApiKey: () => this.provider.apiKey(),
      identity: this.provider.identity,
      // Notion tools will change pages; run them one at a time, in the order the model asked.
      toolExecution: 'sequential',
      transformContext: async (messages) =>
        recent(this.withNotes(messages), this.config.history ?? this.provider.history, toolChars),
    })
    return this.agent
  }

  /**
   * The questions as the model gets them: each with its notes first, then what the user typed. The
   * notes are the mode, for a question in Read only and for the first one back in Edit, then the
   * question's context.
   */
  private withNotes(messages: AgentMessage[]): AgentMessage[] {
    let readOnlyBefore = false
    return messages.map((message) => {
      if (message.role !== 'user') return message
      const readOnly = this.readOnly.has(message)
      const mode = readOnly ? READ_ONLY_NOTE : readOnlyBefore ? EDIT_NOTE : undefined
      readOnlyBefore = readOnly
      const notes = [mode, this.contexts.get(message)].filter(Boolean).join('\n')
      return notes ? { ...message, content: `${notes}\n\n${textOf(message.content)}` } : message
    })
  }

  /**
   * A short title for the conversation `history`, written from its first question and the start of
   * the reply to it. Call it once that reply has come in: it asks the model that answered, so it goes
   * only where the conversation already went, and on the hosted model it spends credits like any
   * request. Resolves undefined, never rejects, when there is no title to use: the request failed,
   * or the model's answer is not a title (see `ModelTitle` in title.ts).
   */
  async title(history: HistoryMessage[]): Promise<string | undefined> {
    // Read now: the next question may change the provider while this request is out.
    const { provider, model } = this
    if (!model) return undefined
    return writeTitle(provider, model, history)
  }

  /**
   * The signed-in user's credits, as the worker reports them. Reading them changes nothing. Throws
   * when they can't be read, or when the answer is not what the panel expects.
   */
  async credits(): Promise<Credits> {
    return readOwn(this.config, 'credits', { utc_offset: utcOffset() }, Credits)
  }

  /**
   * One page of every grant the user was given, newest first: the first page, or the one that
   * `before` (the `next` of the page before it) starts. Read only when the user opens the history.
   */
  async creditGrants(before?: string): Promise<GrantsPage> {
    return readOwn(this.config, 'credits/grants', { before }, GrantsPage)
  }

  /**
   * Credits used per day over one period: the most recent one, or the one that ends before the day
   * `before` (the `earlier` of the period after it). Read only when the user opens the history.
   */
  async creditUsage(before?: string): Promise<UsagePeriod> {
    return readOwn(this.config, 'credits/usage', { utc_offset: utcOffset(), before }, UsagePeriod)
  }

  /** The packs of credits on offer. Read when the settings page opens. */
  async creditPacks(): Promise<Packs> {
    return readOwn(this.config, 'billing/packs', {}, Packs)
  }

  /**
   * Starts buying the pack of `quantity` (a pack's quantity, as `creditPacks` lists it): the worker
   * makes a Stripe Checkout Session for it, for the signed-in user, and gives the URL of its page.
   * Nothing is bought until the user pays there.
   */
  async checkout(quantity: number): Promise<string> {
    return checkout(this.config, quantity)
  }
}

function toUpdate(event: AgentEvent): AgentUpdate | undefined {
  switch (event.type) {
    case 'message_update':
      return event.assistantMessageEvent.type === 'text_delta'
        ? { type: 'text', delta: event.assistantMessageEvent.delta }
        : undefined
    case 'tool_execution_start':
      return { type: 'tool_start', id: event.toolCallId, name: event.toolName, args: event.args }
    case 'tool_execution_end':
      return {
        type: 'tool_end',
        id: event.toolCallId,
        name: event.toolName,
        status: event.isError ? 'failed' : 'done',
        result: resultText(event.result),
      }
    default:
      return undefined
  }
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/** The text a tool result gave the model. */
function resultText(result: { content?: { type: string; text?: string }[] } | undefined): string {
  return (result?.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
}
