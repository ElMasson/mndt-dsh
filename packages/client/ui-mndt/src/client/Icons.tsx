/**
 * The icons of mndt-web, drawn as inline SVG: lucide-react v0.575.0 (ISC license, https://lucide.dev;
 * see THIRD_PARTY_NOTICES.md). Their paths are copied as they are, so the team screen draws exactly
 * the same marks without a dependency.
 */
import type { ReactNode } from 'react'

/** The icons the team screen uses. */
export type IconName =
  | 'Lock'
  | 'ListChecks'
  | 'Layers'
  | 'Hash'
  | 'Bot'
  | 'Boxes'
  | 'ShieldCheck'
  | 'FileCheck2'
  | 'Settings2'
  | 'Radio'
  | 'UserRound'
  | 'User'
  | 'ChevronsUpDown'
  | 'Menu'
  | 'Info'
  | 'X'
  | 'Sparkles'
  | 'Upload'
  | 'MessageSquare'

/** One SVG element of an icon: its tag and attributes. */
type IconNode = readonly (readonly [string, Readonly<Record<string, string>>])[]

const NODES: Readonly<Record<IconName, IconNode>> = {
  Lock: [['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }], ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]],
  ListChecks: [['path', { d: 'M13 5h8' }], ['path', { d: 'M13 12h8' }], ['path', { d: 'M13 19h8' }], ['path', { d: 'm3 17 2 2 4-4' }], ['path', { d: 'm3 7 2 2 4-4' }]],
  Layers: [['path', { d: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z' }], ['path', { d: 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12' }], ['path', { d: 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17' }]],
  Hash: [['line', { x1: '4', x2: '20', y1: '9', y2: '9' }], ['line', { x1: '4', x2: '20', y1: '15', y2: '15' }], ['line', { x1: '10', x2: '8', y1: '3', y2: '21' }], ['line', { x1: '16', x2: '14', y1: '3', y2: '21' }]],
  Bot: [['path', { d: 'M12 8V4H8' }], ['rect', { width: '16', height: '12', x: '4', y: '8', rx: '2' }], ['path', { d: 'M2 14h2' }], ['path', { d: 'M20 14h2' }], ['path', { d: 'M15 13v2' }], ['path', { d: 'M9 13v2' }]],
  Boxes: [['path', { d: 'M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z' }], ['path', { d: 'm7 16.5-4.74-2.85' }], ['path', { d: 'm7 16.5 5-3' }], ['path', { d: 'M7 16.5v5.17' }], ['path', { d: 'M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z' }], ['path', { d: 'm17 16.5-5-3' }], ['path', { d: 'm17 16.5 4.74-2.85' }], ['path', { d: 'M17 16.5v5.17' }], ['path', { d: 'M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z' }], ['path', { d: 'M12 8 7.26 5.15' }], ['path', { d: 'm12 8 4.74-2.85' }], ['path', { d: 'M12 13.5V8' }]],
  ShieldCheck: [['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }], ['path', { d: 'm9 12 2 2 4-4' }]],
  FileCheck2: [['path', { d: 'M10.5 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v6' }], ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }], ['path', { d: 'm14 20 2 2 4-4' }]],
  Settings2: [['path', { d: 'M14 17H5' }], ['path', { d: 'M19 7h-9' }], ['circle', { cx: '17', cy: '17', r: '3' }], ['circle', { cx: '7', cy: '7', r: '3' }]],
  Radio: [['path', { d: 'M16.247 7.761a6 6 0 0 1 0 8.478' }], ['path', { d: 'M19.075 4.933a10 10 0 0 1 0 14.134' }], ['path', { d: 'M4.925 19.067a10 10 0 0 1 0-14.134' }], ['path', { d: 'M7.753 16.239a6 6 0 0 1 0-8.478' }], ['circle', { cx: '12', cy: '12', r: '2' }]],
  UserRound: [['circle', { cx: '12', cy: '8', r: '5' }], ['path', { d: 'M20 21a8 8 0 0 0-16 0' }]],
  User: [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: '12', cy: '7', r: '4' }]],
  ChevronsUpDown: [['path', { d: 'm7 15 5 5 5-5' }], ['path', { d: 'm7 9 5-5 5 5' }]],
  Menu: [['path', { d: 'M4 5h16' }], ['path', { d: 'M4 12h16' }], ['path', { d: 'M4 19h16' }]],
  Info: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 16v-4' }], ['path', { d: 'M12 8h.01' }]],
  X: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  Sparkles: [['path', { d: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z' }], ['path', { d: 'M20 2v4' }], ['path', { d: 'M22 4h-4' }], ['circle', { cx: '4', cy: '20', r: '2' }]],
  Upload: [['path', { d: 'M12 3v12' }], ['path', { d: 'm17 8-5-5-5 5' }], ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }]],
  MessageSquare: [['path', { d: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z' }]],
}

/**
 * Draw one icon, lucide's way: a 24 viewBox, a current-colour stroke of 2, round caps and joins.
 * @param props - its name, its size in pixels (16 by default) and an optional class.
 * @returns the SVG, hidden from assistive technology (the label beside it says what it is).
 */
export function Icon(props: { readonly name: IconName; readonly size?: number; readonly className?: string }): ReactNode {
  const size = props.size ?? 16
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={props.className}
    >
      {NODES[props.name].map(([tag, attrs], index) => {
        const Tag = tag as 'path'
        return <Tag key={index} {...attrs} />
      })}
    </svg>
  )
}
