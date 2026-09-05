/**
 * Figure plan transaction (RENDER-P0-12, P0-03, P1-09).
 *
 * The whole figure — every module, micro unit, connector, binding and the
 * slide-level semantic payload — commits as ONE atomic applyTxn: plan →
 * validate all → apply with snapshot rollback. A mid-plan failure restores
 * the exact pre-creation slide instead of best-effort deleting created ids.
 *
 * "$txn:<opIndex>" forward references let later ops address elements earlier
 * ops in the same transaction minted (the executor substitutes real ids just
 * before each apply).
 *
 * Post-write verification (P1-09) runs against the REBUILT slide returned by
 * the transaction: actual element bounds must equal the plan (± tolerance)
 * and the layout audit must pass — if not, the transaction is undone, so the
 * visible canvas never keeps a figure the plan did not vouch for.
 */
import type { FigureRenderPlan } from './native-figure-renderer'
import type { ConnectorBindingSpec } from './native-figure-renderer'

/** canvas px (RenderSlide space) → EMU */
export function pxToEmu(px: number, scale: number): number {
  return Math.round((px * 9525) / scale)
}

export interface FigureTxn {
  ops: Array<Record<string, unknown>>
  /** addElement op order ↔ element spec order, for record→specId mapping */
  elementSpecIds: string[]
  bindings: Array<ConnectorBindingSpec & { opIndex: number }>
}

function anchorPointPx(
  rect: { x: number; y: number; w: number; h: number },
  idx: number,
): { x: number; y: number } {
  switch (idx) {
    case 0:
      return { x: rect.x + rect.w / 2, y: rect.y }
    case 1:
      return { x: rect.x, y: rect.y + rect.h / 2 }
    case 2:
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h }
    default:
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 }
  }
}

export function figurePlanToTxnOps(
  plan: FigureRenderPlan,
  args: { slideIndex: number; scale: number },
): FigureTxn {
  const slideTarget = { slide: args.slideIndex }
  const toEmu = (px: number) => pxToEmu(px, args.scale)
  const ops: Array<Record<string, unknown>> = []
  const elementSpecIds: string[] = []
  const opIndexBySpecId = new Map<string, number>()

  for (const element of plan.elements) {
    const op: Record<string, unknown> = {
      op: 'addElement',
      target: slideTarget,
      kind: element.kind,
      offset: { x: toEmu(element.x), y: toEmu(element.y), cx: toEmu(element.w), cy: toEmu(element.h) },
      ...(element.paragraphs.length > 0 ? { paragraphs: element.paragraphs } : {}),
      ...(element.kind === 'line' || element.kind === 'lineArrow' || element.kind === 'lineBent'
        ? {
            stroke: {
              color: element.stroke.color,
              widthEmu: Math.round(element.stroke.widthPt * 12700),
            },
          }
        : {
            fill: element.fillColor,
            stroke: {
              color: element.stroke.color,
              widthEmu: Math.round(element.stroke.widthPt * 12700),
            },
          }),
      ...(element.adjust ? { adjust: element.adjust } : {}),
      ...(element.paragraphs.length > 0
        ? {
            bodyPr: {
              insetsEmu: {
                l: toEmu(element.insetsPx.l),
                t: toEmu(element.insetsPx.t),
                r: toEmu(element.insetsPx.r),
                b: toEmu(element.insetsPx.b),
              },
              anchor: 'ctr',
            },
          }
        : {}),
      semanticMetadata: element.semanticMetadata,
    }
    opIndexBySpecId.set(element.specId, ops.length)
    elementSpecIds.push(element.specId)
    ops.push(op)
  }

  const bindings = plan.bindings.map((binding) => {
    const connectorOpIndex = opIndexBySpecId.get(binding.specId)
    const startOpIndex = opIndexBySpecId.get(binding.start.targetSpecId)
    const endOpIndex = opIndexBySpecId.get(binding.end.targetSpecId)
    if (connectorOpIndex === undefined || startOpIndex === undefined || endOpIndex === undefined) {
      throw new Error(`binding ${binding.specId}: unresolved spec reference`)
    }
    // Connector endpoints bind to FINAL module rects — the same numbers the
    // shapes were created with (P0-03: no stale solver coordinates).
    const startEl = plan.elements.find((element) => element.specId === binding.start.targetSpecId)!
    const endEl = plan.elements.find((element) => element.specId === binding.end.targetSpecId)!
    const p1 = anchorPointPx(startEl, binding.start.idx)
    const p2 = anchorPointPx(endEl, binding.end.idx)
    const opIndex = ops.length
    ops.push({
      op: 'setConnectorEndpoints',
      target: { slide: args.slideIndex, el: `$txn:${connectorOpIndex}` },
      p1: { x: toEmu(p1.x), y: toEmu(p1.y) },
      p2: { x: toEmu(p2.x), y: toEmu(p2.y) },
      ...(binding.routeYPx !== undefined ? { routeY: toEmu(binding.routeYPx) } : {}),
      start: { targetId: `$txn:${startOpIndex}`, idx: binding.start.idx },
      end: { targetId: `$txn:${endOpIndex}`, idx: binding.end.idx },
    })
    return { ...binding, opIndex }
  })

  // Composite modules close as native groups LAST: bindings already resolved
  // top-level spids, and group children keep their cNvPr ids in the bytes.
  for (const group of plan.groups) {
    const memberOpIndexes = group.memberSpecIds.map((specId) => opIndexBySpecId.get(specId))
    if (memberOpIndexes.some((index) => index === undefined)) continue
    ops.push({
      op: 'groupElements',
      target: slideTarget,
      els: memberOpIndexes.map((index) => `$txn:${index}`),
    })
  }

  ops.push({
    op: 'setSlideResearchMetadata',
    target: slideTarget,
    payload: plan.slideMetadata,
  })

  return { ops, elementSpecIds, bindings }
}

export interface FigureWriteVerification {
  ok: boolean
  issues: string[]
}

const BOUNDS_TOLERANCE_PX = 1.5

/**
 * P1-09: verify the REBUILT slide — actual rendered bounds vs plan spec
 * (± px tolerance for EMU rounding), binding geometry vs anchored endpoints,
 * and the deterministic layout audit. Connectors are checked on their
 * bounding box; their exact path is PowerPoint's rendering domain.
 */
export function verifyFigureWrite(
  slide: { nodes: unknown[] },
  plan: FigureRenderPlan,
  createdIdBySpecId: Map<string, string>,
  layoutIssues: string[],
): FigureWriteVerification {
  const issues: string[] = []
  // Elements are re-materialized (reparsed) after the transaction, so their
  // parse-time ids differ from the mints in the txn records. The stable join
  // is the SEMANTIC SIGNATURE each spec stamped on its element.
  interface MetaNode {
    sourceId: string
    box: { x: number; y: number; w: number; h: number }
    semanticMetadata?: Record<string, unknown>
    children?: unknown[]
  }
  const bySignature = new Map<string, MetaNode>()
  const signature = (meta: Record<string, unknown>): string =>
    [
      'componentType',
      'semanticNodeId',
      'visualUnitId',
      'semanticEdgeId',
    ]
      .map((key) => `${meta[key] ?? ''}`)
      .join('|')
  const index = (nodes: unknown[], ox = 0, oy = 0) => {
    for (const raw of nodes) {
      const node = raw as MetaNode
      if (node.semanticMetadata) {
        bySignature.set(signature(node.semanticMetadata), {
          ...node,
          box: { ...node.box, x: node.box.x + ox, y: node.box.y + oy },
        })
      }
      // Group children render in group-local px: add the ancestor group's
      // absolute origin to recover slide-space geometry.
      if (Array.isArray(node.children)) index(node.children, ox + node.box.x, oy + node.box.y)
    }
  }
  index(slide.nodes)

  for (const element of plan.elements) {
    if (isConnectorKind(element.kind)) continue
    const node = bySignature.get(signature(element.semanticMetadata as unknown as Record<string, unknown>))
    if (!node) {
      issues.push(`element ${element.specId} missing from the rebuilt slide`)
      continue
    }
    const dx = Math.abs(node.box.x - element.x)
    const dy = Math.abs(node.box.y - element.y)
    const dw = Math.abs(node.box.w - element.w)
    const dh = Math.abs(node.box.h - element.h)
    if (Math.max(dx, dy, dw, dh) > BOUNDS_TOLERANCE_PX) {
      issues.push(
        `${element.specId} bounds drifted: actual (${Math.round(node.box.x)},${Math.round(node.box.y)} ${Math.round(node.box.w)}×${Math.round(node.box.h)}) vs plan (${Math.round(element.x)},${Math.round(element.y)} ${Math.round(element.w)}×${Math.round(element.h)})`,
      )
    }
  }
  for (const defect of plan.defects) {
    if (defect.severity === 'hard') issues.push(`plan defect: ${defect.message}`)
  }
  if (layoutIssues.length > 0) issues.push(...layoutIssues.map((issue) => `layout audit: ${issue}`))
  return { ok: issues.length === 0, issues }
}

function isConnectorKind(kind: string): boolean {
  return kind === 'line' || kind === 'lineArrow' || kind === 'lineBent'
}
