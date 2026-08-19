import { useEffect, useRef } from 'react'
import { useStore, type MailEvent } from '../store'
import { dispatchAgent } from '../shape'
import { getPrefs } from '../prefs'
import { LABEL } from '../theme'
import {
  assignDesks,
  buildOffice,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  findPath,
  randomWalkable,
  rng,
  standingSpot,
  TILE,
  type Office,
  type Point
} from './layout'
import { ATLAS_INDEX, buildAtlas, drawChair, paletteOf, type Palette } from './tiles'
import { drawBubble, drawEnvelope, drawLabel, drawPerson, type Facing } from './sprite'


/** Panel padding, in pixels. The office is fitted to what is left of it. */
const PAD = 12

/** Tiles crossed per second while walking. */
const SPEED = 3.2
/** Chance per second that a rested, bored agent gets up. */
const WANDER_CHANCE = 0.05
/**
 * How long someone stands still after arriving anywhere, in milliseconds.
 *
 * An idle agent used to reach the spot it wandered to, turn on its heel and
 * walk straight back - motion with no rest in it, which reads as a screensaver
 * rather than an office. Only a conversation overrides this: two agents sorting
 * something out is the one thing that should look continuous.
 */
const REST_MIN = 1400
const REST_SPAN = 4200
const ENVELOPE_MS = 1600
/**
 * How long two agents stand together once the sender arrives.
 *
 * Long enough to read as a conversation rather than a collision, short enough
 * that an agent handed three things in a row is not away from its desk for a
 * minute. The walk there and back is on top of it.
 */
// Long enough to catch by looking up, not so long that a busy floor is all
// standing conversations.
const TALK_MS = 4200

type Body = {
  pos: Point
  path: Point[]
  facing: Facing
  frame: number
  progress: number
  next: () => number
  wandering: boolean
  /** Clock this body is standing still until. Set on arriving anywhere. */
  restUntil: number
  /**
   * Someone this agent is walking over to talk to.
   *
   * `until` is 0 until it arrives, and then the clock the conversation ends on.
   * Held on the sender: the message is theirs, and the agent being spoken to
   * stays where it is - it is being interrupted, not summoned.
   */
  errand: { to: string; until: number; said: string } | null
}

type Envelope = { from: Point; to: Point; born: number }

/** Which way to look to face another tile. Diagonals resolve to the long side. */
const facingTo = (from: Point, to: Point): Facing => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'down' : 'up'
}

/**
 * The office floor. Purely a view over the store: nothing here talks to main,
 * spends a token, or changes agent behaviour - an agent looks busy because a
 * lifecycle hook said it was, not the other way round.
 */
export function Floor({ mode, onSelect }: { mode: 'light' | 'dark'; onSelect: (id: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const legendRef = useRef<HTMLDivElement>(null)
  // The office is rebuilt to fit the panel, so it is state the frame loop reads
  // rather than a module constant.
  const office = useRef<Office>(buildOffice(36, 26))
  const bodies = useRef(new Map<string, Body>())
  const envelopes = useRef<Envelope[]>([])
  const seenMail = useRef(0)
  /**
   * Mail whose recipient has no chair yet.
   *
   * Work is handed to a role now, and if nobody holds it somebody is hired on
   * the spot - so the first message to a new agent arrives a beat before the
   * roster says that agent exists. Dropped, which is what happened, the one
   * conversation that mattered most was the one the floor never showed.
   */
  const waiting = useRef<{ m: MailEvent; born: number }[]>([])
  const atlas = useRef<{ canvas: HTMLCanvasElement; palette: Palette } | null>(null)
  /**
   * The room itself, painted once.
   *
   * Every tile of it was redrawn on every frame - two `drawImage` calls per
   * cell, ~1200 a frame for a floor this size, sixty times a second, to produce
   * exactly the same picture. It only changes when the grid is rebuilt, the
   * palette flips or someone takes a new desk, so it is painted then and blitted
   * as one image after.
   */
  const room = useRef<{ canvas: HTMLCanvasElement; key: string } | null>(null)
  /** What the last frame drew, so a still office is not repainted at 60fps. */
  const shown = useRef('')

  // Fit the office to the panel rather than letterboxing a fixed 36x26 grid:
  // in a tall narrow panel that left a short wide floor stranded in the middle
  // with dead space above and below it.
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const fit = (): void => {
      // Inside the padding, not across it: counting the padding in bought a
      // column the panel could not show, and the canvas was scaled to 97% to
      // fit - which on pixel art is a row of half-pixels.
      const roomW = wrap.clientWidth - 2 * PAD
      // The legend sits under the canvas and is not part of the office.
      const roomH = wrap.clientHeight - 2 * PAD - (legendRef.current?.offsetHeight ?? 0)
      const cols = Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(roomW / TILE)))
      const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(roomH / TILE)))
      const changed = cols !== office.current.cols || rows !== office.current.rows
      if (changed) office.current = buildOffice(cols, rows)
      // Always assign, even when the grid did not change: the canvas element
      // carries no width/height attributes, so skipping this on the first pass
      // left it at the 300x150 default and the office was drawn into a corner.
      if (changed || canvas.width !== office.current.cols * TILE) {
        canvas.width = office.current.cols * TILE
        canvas.height = office.current.rows * TILE
        canvas.getContext('2d')!.imageSmoothingEnabled = false
      }
      if (!changed) return
      // Desks moved, so every walk in progress is now a path across a grid that
      // no longer exists. Dropping the bodies re-enters everyone at the door.
      bodies.current.clear()
      shown.current = ''
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    // The palette changed under us: the room is painted in it, and the last
    // frame's signature says nothing about which colours it was painted with.
    room.current = null
    shown.current = ''

    let raf = 0
    let last = performance.now()

    const frame = (now: number): void => {
      // A window nobody is looking at still gets frames, and an office nobody
      // can see still has to be worth drawing. Both cost the same as drawing it.
      if (document.hidden || !canvas.isConnected || canvas.clientWidth === 0) {
        last = now
        raf = requestAnimationFrame(frame)
        return
      }
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now

      // The floor's colours are a setting, and `paletteOf` hands back the same
      // object for the same theme - the atlas check below is an identity
      // comparison, and a fresh object would rebuild every tile every frame.
      const palette = paletteOf(getPrefs().floor, mode)
      if (!atlas.current || atlas.current.palette !== palette) {
        atlas.current = { canvas: buildAtlas(palette), palette }
      }

      const { agents, mail, approvals } = useStore.getState()
      const seats = assignDesks(
        agents.map((a) => a.id),
        office.current,
        dispatchAgent(agents)?.id
      )

      // New mail is someone getting up and walking over. Only entries appended
      // since the last frame, so a full mail list does not replay on every
      // render.
      //
      // The envelope is what is left for mail with nobody to send it: the
      // human, the webhook, Bullpen's own notices. Those have no body on the
      // floor, and a message from the door is better than no message at all.
      const start = (m: MailEvent): boolean => {
        const from = seats.get(m.from)?.seat ?? office.current.door
        const to = seats.get(m.to)?.seat
        if (!to) return false
        const walker = m.from === m.to ? undefined : bodies.current.get(m.from)
        const spot = walker ? standingSpot(office.current.grid, to, walker.pos) : null
        const path = walker && spot ? findPath(office.current.grid, walker.pos, spot) : null
        // Already within earshot: two agents whose desks are a tile apart have
        // nowhere to walk to, and there is no path to where you are standing -
        // so every message between neighbours became a flying envelope and no
        // conversation at all.
        const close =
          walker && Math.abs(walker.pos.x - to.x) + Math.abs(walker.pos.y - to.y) <= 2
        if (walker && (path || close)) {
          walker.path = path ?? []
          walker.wandering = false
          walker.errand = { to: m.to, until: 0, said: m.subject }
          return true
        }
        envelopes.current.push({ from, to, born: now })
        return true
      }

      for (let i = seenMail.current; i < mail.length; i++) {
        const m = mail[i]
        if (!start(m)) waiting.current.push({ m, born: now })
      }
      seenMail.current = mail.length
      // Whoever has sat down since. A few seconds is long enough for a hire to
      // reach the roster and short enough that a message to somebody who never
      // arrives does not turn up minutes later.
      waiting.current = waiting.current.filter(
        (w) => now - w.born < 8000 && !start(w.m)
      )
      envelopes.current = envelopes.current.filter((e) => now - e.born < ENVELOPE_MS)

      for (const agent of agents) {
        const seat = seats.get(agent.id)?.seat
        if (!seat) continue
        let body = bodies.current.get(agent.id)
        if (!body) {
          // Everyone walks in through the door, then finds their desk.
          body = {
            pos: { ...office.current.door },
            path: findPath(office.current.grid, office.current.door, seat) ?? [],
            facing: 'up',
            frame: 0,
            progress: 0,
            next: rng(agent.id),
            wandering: false,
            restUntil: 0,
            errand: null
          }
          bodies.current.set(agent.id, body)
        }
        const desk = seats.get(agent.id)!.desk
        step(body, agent.id, seat, desk, dt, now, approvals.some((p) => p.agentId === agent.id))
      }
      // Two people talking look at each other. Done after everyone has moved,
      // because the one being spoken to may have been walking itself a moment
      // ago and would otherwise face whichever way it happened to stop.
      for (const [, body] of bodies.current) {
        if (!body.errand?.until) continue
        const host = bodies.current.get(body.errand.to)
        if (!host || host.path.length > 0) continue
        body.facing = facingTo(body.pos, host.pos)
        host.facing = facingTo(host.pos, body.pos)
      }
      for (const id of [...bodies.current.keys()]) {
        if (!agents.some((a) => a.id === id)) bodies.current.delete(id)
      }

      // Repaint only when the picture would differ. A floor where everyone is
      // sitting still is a still image, and painting it sixty times a second is
      // sixty times the work for none of the difference. Envelopes animate off
      // the clock, so while one is in flight every frame counts as new.
      // A conversation is two people standing still, which the signature below
      // reads as a still office. The bucket is what keeps the bubble animating
      // without repainting a quiet floor sixty times a second.
      const talking = [...bodies.current.values()].some((b) => b.errand?.until)
      const sig = envelopes.current.length
        ? `mail:${now}`
        : (talking ? `talk:${Math.round(now / 200)}|` : '') +
          agents
            .map((a) => {
              const b = bodies.current.get(a.id)
              return b
                ? `${a.id}:${b.pos.x},${b.pos.y},${Math.round(b.progress * TILE)},${Math.floor(
                    b.frame
                  )},${b.facing},${a.activity},${a.status},${approvals.some((p) => p.agentId === a.id)}`
                : `${a.id}:-`
            })
            .join('|')
      if (sig !== shown.current) {
        draw(ctx, canvas, palette, atlas.current.canvas, now)
        shown.current = sig
      }
      raf = requestAnimationFrame(frame)
    }

    const step = (
      body: Body,
      id: string,
      seat: Point,
      desk: Point,
      dt: number,
      now: number,
      blocked: boolean
    ): void => {
      if (body.path.length > 0) {
        body.progress += dt * SPEED
        // The legs alternate with distance covered, not with tiles arrived at:
        // a frame per tile is one step every 300ms, which reads as a shuffle.
        body.frame += dt * SPEED * 2
        while (body.progress >= 1 && body.path.length > 0) {
          body.progress -= 1
          const nextTile = body.path.shift()!
          body.facing =
            nextTile.x > body.pos.x
              ? 'right'
              : nextTile.x < body.pos.x
                ? 'left'
                : nextTile.y > body.pos.y
                  ? 'down'
                  : 'up'
          body.pos = nextTile
        }
        // Arrived. Someone on their way to talk carries on; everyone else takes
        // a moment before deciding what to do next.
        if (body.path.length === 0 && !body.errand) {
          body.restUntil = now + REST_MIN + body.next() * REST_SPAN
        }
        return
      }

      // Arrived where it was going: stand there for the length of the
      // conversation, then let the walk home happen the way any walk home does.
      if (body.errand) {
        if (!body.errand.until) body.errand.until = now + TALK_MS
        if (now < body.errand.until) return
        body.errand = null
      }

      const atSeat = body.pos.x === seat.x && body.pos.y === seat.y
      const agent = useStore.getState().agents.find((a) => a.id === id)
      const working = agent?.activity === 'working'

      // Standing where it stopped. This is most of what an idle floor is:
      // people who moved a minute ago and have not decided to move again.
      if (body.restUntil > now) {
        if (atSeat && working) body.frame += dt * 6
        return
      }

      // Rested wherever it wandered to, so now it goes back to its desk.
      if (body.wandering && !atSeat) body.wandering = false

      if (!atSeat && !body.wandering) {
        body.path = findPath(office.current.grid, body.pos, seat) ?? []
        return
      }
      // Face the desk, which is above for a pod's front row and below for its
      // back row - otherwise half the office sits with its back to the screen.
      body.facing = desk.y < seat.y ? 'up' : 'down'

      // Only a bored agent wanders. One that is working stays at its desk, and
      // one waiting on a human stays put so you can find it.
      // Per second, which is what the constant says: `* dt * 60` was a roll of
      // WANDER_CHANCE on every single frame, so an agent got up roughly the
      // moment it sat down and the office never stopped moving.
      if (!working && !blocked && body.next() < WANDER_CHANCE * dt) {
        const target = randomWalkable(office.current.grid, body.next, office.current.door)
        const path = findPath(office.current.grid, body.pos, target)
        if (path?.length) {
          body.path = path
          body.wandering = true
        }
      } else if (working && atSeat) {
        // Sitting: cycle frames only while working, so a still floor means a
        // quiet office at a glance.
        body.frame += dt * 6
      }
    }

    const draw = (
      ctx: CanvasRenderingContext2D,
      canvas: HTMLCanvasElement,
      palette: Palette,
      tiles: HTMLCanvasElement,
      now: number
    ): void => {
      const { agents, approvals } = useStore.getState()
      const seats = assignDesks(
        agents.map((a) => a.id),
        office.current,
        dispatchAgent(agents)?.id
      )

      // Chairs belong to the room: they move only when someone takes a desk.
      const key = `${canvas.width}x${canvas.height}|${palette.floor}|${[...seats.values()]
        .map((d) => `${d.seat.x},${d.seat.y}`)
        .join(';')}`
      if (!room.current || room.current.key !== key) {
        const layer = room.current?.canvas ?? document.createElement('canvas')
        layer.width = canvas.width
        layer.height = canvas.height
        const lc = layer.getContext('2d')!
        lc.imageSmoothingEnabled = false
        lc.fillStyle = palette.floor
        lc.fillRect(0, 0, layer.width, layer.height)
        for (let y = 0; y < office.current.rows; y++) {
          for (let x = 0; x < office.current.cols; x++) {
            const under = office.current.ground[y][x]
            lc.drawImage(tiles, ATLAS_INDEX[under] * TILE, 0, TILE, TILE, x * TILE, y * TILE, TILE, TILE)
            const cell = office.current.grid[y][x]
            if (cell === under) continue
            lc.drawImage(tiles, ATLAS_INDEX[cell] * TILE, 0, TILE, TILE, x * TILE, y * TILE, TILE, TILE)
          }
        }
        for (const [, d] of seats) drawChair(lc, d.seat.x * TILE, d.seat.y * TILE, palette)
        room.current = { canvas: layer, key }
      }
      ctx.drawImage(room.current.canvas, 0, 0)

      // Where each person ended up on screen, so a conversation can be drawn
      // over both of them after everyone has been painted.
      const at = new Map<string, { px: number; py: number }>()
      for (const agent of agents) {
        const body = bodies.current.get(agent.id)
        if (!body) continue
        // Between the tile behind and the tile ahead, so a walk is a walk and
        // not a jump every 300ms. Rounded to whole pixels: this is a pixel-art
        // sprite, and half a pixel of it is a smear.
        const ahead = body.path[0]
        const t = ahead ? Math.min(1, body.progress) : 0
        const gx = ahead ? body.pos.x + (ahead.x - body.pos.x) * t : body.pos.x
        const gy = ahead ? body.pos.y + (ahead.y - body.pos.y) * t : body.pos.y
        const px = Math.round(gx * TILE) + 3
        const py = Math.round(gy * TILE) + 1
        at.set(agent.id, { px, py })
        const blocked = approvals.some((p) => p.agentId === agent.id)
        const typing = agent.activity === 'working' && body.path.length === 0
        ctx.fillStyle = palette.shadow
        ctx.fillRect(px, py + 13, 10, 2)
        drawPerson(
          ctx,
          agent.face,
          agent.color,
          px,
          py,
          body.facing,
          Math.floor(body.frame),
          typing ? (Math.floor(body.frame) % 2 === 0 ? 0 : 1) : 0
        )

        // Not while they are talking: two labels a tile apart overlap each
        // other and cover the bubbles, which is the one thing on this floor
        // worth looking at when it happens.
        const talking =
          Boolean(body.errand?.until) ||
          [...bodies.current.values()].some((b) => b.errand?.until && b.errand.to === agent.id)
        if (talking) continue

        const status = agent.status === 'exited' ? 'gone' : blocked ? 'needs you' : agent.activity
        drawLabel(
          ctx,
          `${agent.name} · ${status}`,
          px + 5,
          py - 12,
          blocked ? '#241f1a' : mode === 'light' ? '#3b3b46' : '#d9dce2',
          blocked ? '#e0a800' : mode === 'light' ? '#ffffffd8' : '#161822d8'
        )
      }

      // The conversation itself: a bubble over each of the two, filling in as it
      // goes so a glance says whether they have just started or are wrapping up.
      for (const [id, body] of bodies.current) {
        if (!body.errand?.until) continue
        const host = bodies.current.get(body.errand.to)
        if (!host || host.path.length > 0) continue
        const spoke = at.get(id)
        const heard = at.get(body.errand.to)
        if (!spoke || !heard) continue
        const left = TALK_MS - (body.errand.until - now)
        const dots = Math.floor((left / TALK_MS) * 3) + 1
        drawBubble(ctx, spoke.px - 2, spoke.py - 34, dots)
        drawBubble(ctx, heard.px - 2, heard.py - 34, dots - 1)
        // What it is about, between the two of them. The bubbles say a
        // conversation is happening; this says which one - and on a floor where
        // two agents sit a tile apart, the walk is too short to read as one.
        if (body.errand.said) {
          drawLabel(
            ctx,
            body.errand.said.slice(0, 40),
            Math.round((spoke.px + heard.px) / 2) - 20,
            Math.min(spoke.py, heard.py) - 46,
            mode === 'light' ? '#3b3b46' : '#d9dce2',
            mode === 'light' ? '#ffffffe8' : '#161822e8'
          )
        }
      }

      for (const e of envelopes.current) {
        const t = Math.min(1, (now - e.born) / ENVELOPE_MS)
        const x = e.from.x + (e.to.x - e.from.x) * t
        const y = e.from.y + (e.to.y - e.from.y) * t
        // A small arc, so an envelope reads as flying rather than sliding.
        const lift = Math.sin(t * Math.PI) * 10
        drawEnvelope(ctx, x * TILE + 3, y * TILE - lift)
      }
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [mode])

  const click = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * office.current.cols)
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * office.current.rows)
    const { agents } = useStore.getState()
    for (const agent of agents) {
      const body = bodies.current.get(agent.id)
      if (body && Math.abs(body.pos.x - x) <= 1 && Math.abs(body.pos.y - y) <= 1) return onSelect(agent.id)
    }
  }

  return (
    <div ref={wrapRef} style={S.wrap}>
      <canvas ref={canvasRef} onClick={click} style={S.canvas} />
      <div ref={legendRef} style={{ ...LABEL, color: 'var(--faint)', marginTop: 8 }}>
        deterministic · reads agent status, spends nothing · click someone to open their terminal
      </div>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: {
    // Fills the panel so the office can sit in the middle of it: the pane is
    // resizable, and a drawing pinned to the top of a tall panel reads as a
    // rendering bug.
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    // Centred both ways: the office is a drawing with a size of its own, and a
    // panel taller than it should leave the room in the middle rather than
    // pinned to the top with a field of empty panel under it.
    justifyContent: 'center',
    minHeight: 0,
    padding: PAD,
    overflow: 'hidden',
    background: 'var(--sunk)'
  },
  canvas: {
    // The grid is built to the panel's proportions up to a cap, so the canvas
    // draws at its natural size and only shrinks when the panel is smaller than
    // that. Stretching it to fill a tall panel is what made a wall of desks.
    maxWidth: '100%',
    // The panel is resizable now, so the office has to survive being given less
    // room than it draws in. Both maximums plus contain: it scales down whole,
    // rather than being squashed out of proportion by the flex line.
    maxHeight: '100%',
    minHeight: 0,
    objectFit: 'contain',
    imageRendering: 'pixelated',
    border: '1px solid var(--line)',
    cursor: 'pointer'
  }
}
