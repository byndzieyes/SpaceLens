import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'
import type { TreemapData, TreemapItem } from './treemapData'

export interface TreemapRectangle {
  readonly item: TreemapItem
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface LayoutNode {
  item: TreemapItem | null
  children?: LayoutNode[]
}

/** D3 owns only fresh layout nodes; snapshot order and metadata stay unchanged. */
export function calculateTreemap(
  data: TreemapData,
  width: number,
  height: number,
  padding = 2
): TreemapRectangle[] {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(width * height) ||
    !Number.isFinite(padding) ||
    padding < 0 ||
    data.totalBytes <= 0
  )
    return []
  const root = hierarchy<LayoutNode>({
    item: null,
    children: data.children
      .filter((item) => item.bytes !== null && item.bytes > 0)
      .map((item) => ({ item }))
  })
    .sum((node) => node.item?.bytes ?? 0)
    .sort(
      (a, b) =>
        (b.value ?? 0) - (a.value ?? 0) ||
        ((a.data.item?.entry.id ?? '') < (b.data.item?.entry.id ?? '') ? -1 : 1)
    )
  const layout = treemap<LayoutNode>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner(padding)(root)
  return (layout.children ?? []).flatMap((node) => {
    if (!node.data.item || ![node.x0, node.y0, node.x1, node.y1].every(Number.isFinite)) return []
    const x = Math.max(0, Math.min(width, node.x0))
    const y = Math.max(0, Math.min(height, node.y0))
    return [
      {
        item: node.data.item,
        x,
        y,
        width: Math.max(0, Math.min(width, node.x1) - x),
        height: Math.max(0, Math.min(height, node.y1) - y)
      }
    ]
  })
}
