// A single resilient WebSocket to /control/<roomId> that carries every
// tutor-driven realtime message (camera follow + live calculator). Features
// subscribe by message `type`; the tutor (host) sends, students (guests)
// receive. Auto-reconnects, and re-emits a synthetic 'open' event each time the
// socket (re)connects so the host can re-broadcast its current state.
type Handler = (msg: any) => void

// State-style messages whose latest value should be replayed to a handler that
// subscribes after the message already arrived. The server sends these once when
// a guest connects (e.g. the tutor's current page), which can land before the
// feature that listens for them has mounted — so we cache the last one and
// deliver it on subscribe. (Event-style messages like 'calc' open/close aren't
// cached; they're handled in sequence.)
const STICKY_TYPES = new Set(['camera', 'page', 'mode', 'free-reign', 'calc-access'])

export class ControlChannel {
  private socket: WebSocket | null = null
  private disposed = false
  private handlers = new Map<string, Set<Handler>>()
  private lastByType = new Map<string, any>()

  constructor(
    private readonly roomId: string,
    readonly isHost: boolean,
  ) {
    this.connect()
  }

  private url() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const role = this.isHost ? 'host' : 'guest'
    return `${proto}://${window.location.host}/control/${encodeURIComponent(this.roomId)}?role=${role}`
  }

  private connect() {
    if (this.disposed) return
    const ws = new WebSocket(this.url())
    this.socket = ws
    ws.onopen = () => this.emit('open', { type: 'open' })
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        if (msg && msg.type) {
          if (STICKY_TYPES.has(msg.type)) this.lastByType.set(msg.type, msg)
          this.emit(msg.type, msg)
        }
      } catch {
        /* ignore malformed frames */
      }
    }
    ws.onclose = () => {
      this.socket = null
      if (!this.disposed) setTimeout(() => this.connect(), 1000)
    }
    ws.onerror = () => ws.close()
  }

  private emit(type: string, msg: any) {
    this.handlers.get(type)?.forEach((h) => h(msg))
  }

  /** Subscribe to a message type (or the synthetic 'open'). Returns an unsubscribe fn. */
  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(handler)
    // Replay the latest cached value for sticky state-types, so a late subscriber
    // immediately gets the current camera/page/mode/etc. it would otherwise miss.
    if (STICKY_TYPES.has(type) && this.lastByType.has(type)) {
      const cached = this.lastByType.get(type)
      queueMicrotask(() => {
        if (!this.disposed && this.handlers.get(type)?.has(handler)) handler(cached)
      })
    }
    return () => {
      set!.delete(handler)
    }
  }

  send(msg: unknown) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg))
    }
  }

  dispose() {
    this.disposed = true
    this.socket?.close()
    this.handlers.clear()
  }
}
