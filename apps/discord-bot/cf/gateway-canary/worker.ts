import { DurableObject } from 'cloudflare:workers'

const leaseMs = 120_000
const slotMs = 10 * 60_000
const gateway = 'https://gateway.discord.gg/?v=10&encoding=json'
const testChannelId = '1373597443798859776'
const identifyBudget = 3

type Cursor = { readonly sessionId: string; readonly sequence: number; readonly resumeUrl: string }
type Lease = { readonly owner: string; readonly expiresAt: number }
type Sample = {
  readonly identifies: number
  readonly resumes: number
  readonly messages: number
  readonly lastHandoffMs?: number
}

export class Coordinator extends DurableObject {
  acquire(owner: string) {
    return this.ctx.storage.transactionSync(() => {
      const kv = this.ctx.storage.kv
      const lease = kv.get<Lease>('lease')
      if (lease !== undefined && lease.expiresAt > Date.now()) return null
      kv.put('lease', { owner, expiresAt: Date.now() + leaseMs })
      return { cursor: kv.get<Cursor>('cursor') }
    })
  }

  allowIdentify(owner: string) {
    return this.ctx.storage.transactionSync(() => {
      const kv = this.ctx.storage.kv
      const lease = kv.get<Lease>('lease')
      const attempts = kv.get<number>('identifyAttempts') ?? 0
      if (lease?.owner !== owner || lease.expiresAt <= Date.now() || attempts >= identifyBudget) return false
      kv.put('identifyAttempts', attempts + 1)
      return true
    })
  }

  checkpoint(owner: string, cursor: Cursor | undefined, event?: 'READY' | 'RESUMED' | 'MESSAGE_CREATE') {
    return this.ctx.storage.transactionSync(() => {
      const kv = this.ctx.storage.kv
      const lease = kv.get<Lease>('lease')
      if (lease?.owner !== owner || lease.expiresAt <= Date.now()) return false
      kv.put('lease', { owner, expiresAt: Date.now() + leaseMs })
      if (cursor === undefined) kv.delete('cursor')
      else kv.put('cursor', cursor)
      if (event !== undefined) {
        const sample = kv.get<Sample>('sample') ?? { identifies: 0, resumes: 0, messages: 0 }
        const releasedAt = kv.get<number>('releasedAt')
        const handoff = event !== 'MESSAGE_CREATE' && releasedAt !== undefined
        if (handoff === true) kv.delete('releasedAt')
        kv.put('sample', {
          ...sample,
          ...(handoff === true ? { lastHandoffMs: Date.now() - releasedAt } : {}),
          identifies: sample.identifies + Number(event === 'READY'),
          resumes: sample.resumes + Number(event === 'RESUMED'),
          messages: sample.messages + Number(event === 'MESSAGE_CREATE'),
        })
      }
      return true
    })
  }

  release(owner: string) {
    const kv = this.ctx.storage.kv
    this.ctx.storage.transactionSync(() => {
      if (kv.get<Lease>('lease')?.owner !== owner) return
      kv.delete('lease')
      if (kv.get('releasedAt') === undefined) kv.put('releasedAt', Date.now())
    })
  }

  report() {
    const kv = this.ctx.storage.kv
    const lease = kv.get<Lease>('lease')
    return {
      leaseActive: lease !== undefined && lease.expiresAt > Date.now(),
      sample: kv.get<Sample>('sample'),
      identifyAttempts: kv.get<number>('identifyAttempts') ?? 0,
    }
  }
}

type Env = {
  readonly COORDINATOR: DurableObjectNamespace<Coordinator>
  readonly DISCORD_TOKEN: string
  readonly RUN_UNTIL: string
  readonly STAGING_APPLICATION_ID: string
}

/** Only reads Gateway traffic. No message contents, IDs, or interaction tokens enter storage or logs. */
const resumeUrl = (value: string): string => {
  const url = new URL(value)
  if (
    url.protocol !== 'wss:' ||
    (url.hostname !== 'gateway.discord.gg' && url.hostname.endsWith('.discord.gg') === false)
  ) {
    throw new Error('Invalid Discord resume endpoint')
  }
  url.protocol = 'https:'
  url.search = '?v=10&encoding=json'
  return url.toString()
}

const runSlot = async (
  env: Env,
  coordinator: DurableObjectStub<Coordinator>,
  owner: string,
  saved: Cursor | undefined,
  runUntil: number,
) => {
  const signal = AbortSignal.timeout(Math.min(slotMs, Math.max(1, runUntil - Date.now())))
  const authorization = `Bot ${env.DISCORD_TOKEN}`
  const identity = await fetch('https://discord.com/api/v10/oauth2/applications/@me', {
    headers: { Authorization: authorization, 'User-Agent': 'DiscordBot (https://livestore.dev, 1)' },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
  if (identity.ok === false || (await identity.json<{ id?: string }>()).id !== env.STAGING_APPLICATION_ID) {
    throw new Error('The canary token must belong to the staging Discord application')
  }
  if (signal.aborted === true) return
  const opening = new AbortController()
  const deadline = setTimeout(() => opening.abort(), 10_000)
  const upgraded = await fetch(saved?.resumeUrl ?? gateway, {
    headers: { Upgrade: 'websocket' },
    redirect: 'manual',
    signal: opening.signal,
  }).finally(() => clearTimeout(deadline))
  const socket = upgraded.webSocket
  if (socket === null || upgraded.status !== 101) throw new Error('Discord Gateway upgrade failed')

  let cursor = saved
  let firstHeartbeat: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let serial = Promise.resolve()
  let acknowledged = true

  try {
    await new Promise<void>((resolve, reject) => {
      const send = (op: number, d: unknown) => socket.send(JSON.stringify({ op, d }))
      const checkpoint = async (event?: 'READY' | 'RESUMED' | 'MESSAGE_CREATE') => {
        if ((await coordinator.checkpoint(owner, cursor, event)) === false) throw new Error('Canary lost ownership')
      }
      const beat = async (checkAck = true) => {
        if (checkAck === true && acknowledged === false) throw new Error('Discord heartbeat was not acknowledged')
        await checkpoint()
        acknowledged = false
        send(1, cursor?.sequence ?? null)
      }
      const enqueue = (work: () => Promise<void>) => {
        serial = serial.then(work)
        void serial.catch(reject)
      }

      if (signal.aborted === true) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
      socket.addEventListener('close', ({ code }) => {
        if (code === 4007 || code === 4009) {
          enqueue(async () => {
            cursor = undefined
            await checkpoint()
            resolve()
          })
        } else {
          resolve()
        }
      })
      socket.addEventListener('error', () => reject(new Error('Discord Gateway socket failed')))
      socket.addEventListener('message', ({ data }) => {
        enqueue(async () => {
          if (typeof data !== 'string') throw new Error('Expected a Discord Gateway text frame')
          const frame = JSON.parse(data) as {
            op: number
            s?: number
            t?: string
            d?:
              | { heartbeat_interval?: number; session_id?: string; resume_gateway_url?: string; channel_id?: string }
              | boolean
          }
          if (frame.op === 10 && typeof frame.d === 'object' && frame.d !== null) {
            const interval = frame.d.heartbeat_interval
            if (typeof interval !== 'number' || interval < 1_000 || firstHeartbeat !== undefined) {
              throw new Error('Invalid Discord heartbeat interval')
            }
            firstHeartbeat = setTimeout(() => {
              enqueue(beat)
              heartbeat = setInterval(() => enqueue(beat), interval)
            }, Math.random() * interval)
            if (cursor === undefined) {
              if ((await coordinator.allowIdentify(owner)) === false) throw new Error('Canary IDENTIFY budget reached')
              send(2, {
                token: env.DISCORD_TOKEN,
                intents: 513,
                properties: { os: 'cloudflare', browser: 'livestore-canary', device: 'livestore-canary' },
              })
            } else {
              send(6, { token: env.DISCORD_TOKEN, session_id: cursor.sessionId, seq: cursor.sequence })
            }
          } else if (frame.op === 11) {
            acknowledged = true
          } else if (frame.op === 1) {
            await beat(false)
          } else if (frame.op === 7 || frame.op === 9) {
            if (frame.op === 9 && frame.d === false) {
              cursor = undefined
              await checkpoint()
            }
            resolve()
          } else if (frame.op === 0 && typeof frame.s === 'number') {
            if (frame.t === 'READY') {
              if (
                typeof frame.d !== 'object' ||
                frame.d.session_id === undefined ||
                frame.d.resume_gateway_url === undefined
              ) {
                throw new Error('Invalid Discord READY frame')
              }
              cursor = {
                sessionId: frame.d.session_id,
                sequence: frame.s,
                resumeUrl: resumeUrl(frame.d.resume_gateway_url),
              }
            } else if (cursor !== undefined) {
              cursor = { ...cursor, sequence: frame.s }
            }
            const event = frame.t
            const testMessage =
              event === 'MESSAGE_CREATE' && typeof frame.d === 'object' && frame.d?.channel_id === testChannelId
            await checkpoint(event === 'READY' || event === 'RESUMED' || testMessage === true ? event : undefined)
          }
        })
      })
      socket.accept()
    })
  } finally {
    clearTimeout(firstHeartbeat)
    clearInterval(heartbeat)
    // 1000 and 1001 invalidate the session. An application close preserves the resume cursor.
    socket.close(4000, 'Rotate canary slot')
    await serial
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env) {
    const remaining = Date.parse(env.RUN_UNTIL) - Date.now()
    if (Number.isFinite(remaining) === false || remaining <= 0 || remaining > 60 * 60_000) return
    const owner = crypto.randomUUID()
    const coordinator = env.COORDINATOR.getByName('staging')
    const admission = await coordinator.acquire(owner)
    if (admission === null) return
    try {
      await runSlot(env, coordinator, owner, admission.cursor, Date.parse(env.RUN_UNTIL))
    } catch {
      // Do not emit the payload or upstream exception, which could contain Discord identifiers.
      throw new Error('Discord Gateway canary slot failed')
    } finally {
      await coordinator.release(owner)
    }
  },

  async fetch(request: Request, env: Env) {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/status') {
      return new Response('Not found', { status: 404 })
    }
    return Response.json(await env.COORDINATOR.getByName('staging').report())
  },
} satisfies ExportedHandler<Env>
