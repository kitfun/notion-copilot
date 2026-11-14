// Stands in for PostHog's ingestion host (VITE_POSTHOG_HOST in vitest.config.ts): keeps every
// request the panel's analytics sent, whole, and the events in them.
import { z } from '../src/zod'

export const POSTHOG = 'https://posthog.test'

const Event = z.object({ event: z.string(), properties: z.record(z.string(), z.unknown()) }).loose()
/** What the SDK posts: its events as a batch, also when there is one. */
const Body = z.object({ batch: z.array(Event) })
export type SentEvent = z.infer<typeof Event>

export class FakePostHog {
  /** Every request, as text: its URL and its body, exactly as sent. */
  readonly requests: string[] = []
  /** Every event sent, in order, with all it carried. */
  readonly events: SentEvent[] = []
  /** When set, every request is answered with this status, like PostHog failing. */
  failWith?: number

  async handle(request: Request): Promise<Response> {
    const text = await request.text()
    this.requests.push(`${request.method} ${request.url}\n${text}`)
    this.events.push(...Body.parse(JSON.parse(text)).batch)
    if (this.failWith) return new Response('unavailable', { status: this.failWith })
    return Response.json({ status: 1 })
  }

  /** The names of the events sent, in order. */
  names(): string[] {
    return this.events.map((each) => each.event)
  }

  /** The events named `name`, as their properties. */
  named(name: string): Record<string, unknown>[] {
    return this.events.filter((each) => each.event === name).map((each) => each.properties)
  }
}
