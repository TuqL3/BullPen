import { faceFor } from '../roster'

export type Facing = 'down' | 'up' | 'left' | 'right'

/**
 * A 10x14 person, drawn from the same palette as the roster portrait so the
 * figure at the desk is recognisably the same agent as the face in the list.
 *
 * Two walk frames, not four: the legs alternate, which is all that reads at
 * this size. Add frames when the animation looks wrong, not before.
 */
export function drawPerson(
  ctx: CanvasRenderingContext2D,
  seed: string,
  shirt: string | undefined,
  x: number,
  y: number,
  facing: Facing,
  frame: number,
  bob: number
): void {
  const { colors } = faceFor(seed, shirt)
  const H = colors.H
  const S = colors.S
  const T = colors.T
  const EYE = '#241f1a'
  const top = y + bob

  const px = (dx: number, dy: number, w: number, h: number, fill: string) => {
    ctx.fillStyle = fill
    ctx.fillRect(x + dx, top + dy, w, h)
  }

  // hair + head
  px(2, 0, 6, 2, H)
  px(1, 1, 8, 4, H)
  px(2, 2, 6, 4, S)

  if (facing === 'down') {
    px(3, 4, 1, 1, EYE)
    px(6, 4, 1, 1, EYE)
  } else if (facing === 'left') {
    px(2, 4, 1, 1, EYE)
    px(1, 2, 1, 4, H)
  } else if (facing === 'right') {
    px(7, 4, 1, 1, EYE)
    px(8, 2, 1, 4, H)
  } else {
    // Facing away: all hair, no face. Cheapest possible "back of the head".
    px(2, 2, 6, 4, H)
  }

  // body
  px(1, 7, 8, 5, T)
  px(0, 8, 1, 3, T) // arms
  px(9, 8, 1, 3, T)

  // legs, alternating with the walk frame
  const swing = frame % 2 === 0
  px(2, 12, 3, 2, swing ? '#3c4250' : '#2c3140')
  px(5, 12, 3, 2, swing ? '#2c3140' : '#3c4250')
}

/** A flying envelope, used to show a hive message crossing the floor. */
export function drawEnvelope(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = '#fffdf5'
  ctx.fillRect(x, y, 10, 7)
  ctx.fillStyle = '#c9a25c'
  ctx.fillRect(x, y, 10, 1)
  ctx.fillRect(x, y + 6, 10, 1)
  ctx.fillRect(x, y, 1, 7)
  ctx.fillRect(x + 9, y, 1, 7)
  // The flap: two diagonals meeting in the middle.
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(x + 1 + i, y + 1 + i, 1, 1)
    ctx.fillRect(x + 8 - i, y + 1 + i, 1, 1)
  }
}

/** Status text above a head, in the chunky style the rest of the UI uses. */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  fg: string,
  bg: string
): void {
  ctx.font = '8px ui-monospace, Menlo, Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const w = Math.ceil(ctx.measureText(text).width) + 6
  ctx.fillStyle = bg
  ctx.fillRect(Math.round(cx - w / 2), y, w, 11)
  ctx.fillStyle = fg
  ctx.fillText(text, Math.round(cx), y + 2)
}

/**
 * A speech bubble, for two agents standing together.
 *
 * Mail used to be an envelope flying between two desks, which said a message
 * had been sent and nothing about anyone talking. The dots fill in over the
 * length of the conversation, so a bubble that has been up for a while looks
 * different from one that just appeared - otherwise a still frame cannot tell
 * a chat starting from a chat about to end.
 */
export function drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, dots: number): void {
  const W = 14
  const H = 9
  ctx.fillStyle = '#fffdf5'
  ctx.fillRect(x, y, W, H)
  ctx.fillStyle = '#241f1a'
  // A one-pixel outline, drawn as four edges: strokeRect on half pixels is a
  // grey smear at this scale.
  ctx.fillRect(x, y, W, 1)
  ctx.fillRect(x, y + H - 1, W, 1)
  ctx.fillRect(x, y, 1, H)
  ctx.fillRect(x + W - 1, y, 1, H)
  // The tail, pointing down at whoever is speaking.
  ctx.fillStyle = '#fffdf5'
  ctx.fillRect(x + 3, y + H, 3, 1)
  ctx.fillRect(x + 3, y + H + 1, 2, 1)
  ctx.fillStyle = '#241f1a'
  ctx.fillRect(x + 2, y + H, 1, 1)
  ctx.fillRect(x + 6, y + H, 1, 1)
  ctx.fillRect(x + 5, y + H + 1, 1, 1)
  ctx.fillRect(x + 3, y + H + 2, 2, 1)

  ctx.fillStyle = '#5c5750'
  for (let i = 0; i < Math.max(1, Math.min(3, dots)); i++) {
    ctx.fillRect(x + 3 + i * 3, y + 4, 2, 2)
  }
}
