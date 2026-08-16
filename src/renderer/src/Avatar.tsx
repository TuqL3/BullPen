import { faceFor, FACE_SIZE } from './avatar'

/**
 * SVG rather than canvas: no ref juggling, scales to any size, and
 * shapeRendering="crispEdges" keeps the pixels hard at every zoom level.
 */
export function Avatar({ id, size = 26, shirt }: { id: string; size?: number; shirt?: string }) {
  const { grid, colors } = faceFor(id, shirt)
  const cells: React.ReactElement[] = []

  grid.forEach((row, y) => {
    ;[...row].forEach((ch, x) => {
      if (ch === '.') return
      cells.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={colors[ch]} />)
    })
  })

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${FACE_SIZE} ${FACE_SIZE}`}
      shapeRendering="crispEdges"
      style={{ display: 'block', flex: '0 0 auto' }}
      aria-label={`${id} avatar`}
    >
      {/* A plate behind the bust: without it the portrait dissolves into
          whichever panel it sits on, in either theme. */}
      <rect x={0} y={0} width={FACE_SIZE} height={FACE_SIZE} fill="var(--sunk)" />
      {cells}
    </svg>
  )
}
