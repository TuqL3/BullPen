import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { LABEL } from '../theme'
import {
  assignDesks,
  buildOffice,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  findPath,
  randomWalkable,
  rng,
  TILE,
  type Office,
  type Point
} from './layout'
import { ATLAS_INDEX, buildAtlas, drawChair, PALETTES, type Palette } from './tiles'
import { drawEnvelope, drawLabel, drawPerson, type Facing } from './sprite'


/** Tiles crossed per second while walking. */
const SPEED = 3.2
/** Chance per second that a bored agent gets up. */
const WANDER_CHANCE = 0.12
const ENVELOPE_MS = 1600

type Body = {
  pos: Point
  path: Point[]
  facing: Facing
  frame: number
  progress: number
  next: () => number
  wandering: boolean
}

type Envelope = { from: Point; to: Point; born: number }

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
  const atlas = useRef<{ canvas: HTMLCanvasElement; palette: Palette } | null>(null)

  // Fit the office to the panel rather than letterboxing a fixed 36x26 grid:
  // in a tall narrow panel that left a short wide floor stranded in the middle
  // with dead space above and below it.
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const fit = (): void => {
      const cols = Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(wrap.clientWidth / TILE)))
      // Height is not negotiable: the floor is four rows of desks, and its panel
      // is sized by that rather than the other way round. Measuring the panel
      // here would be circular now that the panel takes its size from this.
      const rows = MAX_ROWS
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

    let raf = 0
    let last = performance.now()

    const frame = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now

      const palette = PALETTES[mode]
      if (!atlas.current || atlas.current.palette !== palette) {
        atlas.current = { canvas: buildAtlas(palette), palette }
      }

      const { agents, mail, approvals } = useStore.getState()
      const seats = assignDesks(
        agents.map((a) => a.id),
        office.current,
        agents.find((a) => a.role === 'god')?.id
      )

      // New mail becomes an envelope in flight. Only entries appended since the
      // last frame, so a full mail list does not replay on every render.
      for (let i = seenMail.current; i < mail.length; i++) {
        const m = mail[i]
        const from = seats.get(m.from)?.seat ?? office.current.door
        const to = seats.get(m.to)?.seat
        if (to) envelopes.current.push({ from, to, born: now })
      }
      seenMail.current = mail.length
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
            wandering: false
          }
          bodies.current.set(agent.id, body)
        }
        const desk = seats.get(agent.id)!.desk
        step(body, agent.id, seat, desk, dt, approvals.some((p) => p.agentId === agent.id))
      }
      for (const id of [...bodies.current.keys()]) {
        if (!agents.some((a) => a.id === id)) bodies.current.delete(id)
      }

      draw(ctx, canvas, palette, atlas.current.canvas, now)
      raf = requestAnimationFrame(frame)
    }

    const step = (
      body: Body,
      id: string,
      seat: Point,
      desk: Point,
      dt: number,
      blocked: boolean
    ): void => {
      if (body.path.length > 0) {
        body.progress += dt * SPEED
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
          body.frame++
        }
        return
      }

      const atSeat = body.pos.x === seat.x && body.pos.y === seat.y

      // Arrived at a wander target: clear the flag so the next tick routes it
      // home. Without this an idle agent walks off and stands there forever.
      if (body.wandering && !atSeat) body.wandering = false

      if (!atSeat && !body.wandering) {
        body.path = findPath(office.current.grid, body.pos, seat) ?? []
        return
      }
      const agent = useStore.getState().agents.find((a) => a.id === id)
      const working = agent?.activity === 'working'
      // Face the desk, which is above for a pod's front row and below for its
      // back row - otherwise half the office sits with its back to the screen.
      body.facing = desk.y < seat.y ? 'up' : 'down'

      // Only a bored agent wanders. One that is working stays at its desk, and
      // one waiting on a human stays put so you can find it.
      if (!working && !blocked && !body.wandering && body.next() < WANDER_CHANCE * dt * 60) {
        const target = randomWalkable(office.current.grid, body.next, office.current.door)
        const path = findPath(office.current.grid, body.pos, target)
        if (path?.length) {
          body.path = path
          body.wandering = true
        }
      } else if (!body.wandering && atSeat) {
        // Sitting: cycle frames only while working, so a still floor means a
        // quiet office at a glance.
        if (working) body.frame += dt * 6
      }
    }

    const draw = (
      ctx: CanvasRenderingContext2D,
      canvas: HTMLCanvasElement,
      palette: Palette,
      tiles: HTMLCanvasElement,
      now: number
    ): void => {
      ctx.fillStyle = palette.floor
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      for (let y = 0; y < office.current.rows; y++) {
        for (let x = 0; x < office.current.cols; x++) {
          const under = office.current.ground[y][x]
          ctx.drawImage(tiles, ATLAS_INDEX[under] * TILE, 0, TILE, TILE, x * TILE, y * TILE, TILE, TILE)
          const cell = office.current.grid[y][x]
          if (cell === under) continue
          ctx.drawImage(tiles, ATLAS_INDEX[cell] * TILE, 0, TILE, TILE, x * TILE, y * TILE, TILE, TILE)
        }
      }

      const { agents, approvals } = useStore.getState()
      const seats = assignDesks(
        agents.map((a) => a.id),
        office.current,
        agents.find((a) => a.role === 'god')?.id
      )
      for (const [, d] of seats) drawChair(ctx, d.seat.x * TILE, d.seat.y * TILE, palette)

      for (const agent of agents) {
        const body = bodies.current.get(agent.id)
        if (!body) continue
        const px = body.pos.x * TILE + 3
        const py = body.pos.y * TILE + 1
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
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: 12,
    overflow: 'hidden',
    background: 'var(--sunk)'
  },
  canvas: {
    // The grid is built to the panel's proportions up to a cap, so the canvas
    // draws at its natural size and only shrinks when the panel is smaller than
    // that. Stretching it to fill a tall panel is what made a wall of desks.
    maxWidth: '100%',
    imageRendering: 'pixelated',
    border: '1px solid var(--line)',
    cursor: 'pointer'
  }
}
