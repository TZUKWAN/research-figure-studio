/**
 * Research figure metadata builders (RENDER-P0-08/09/10).
 *
 * Per-shape SemanticMetadata carries enough refs to identify and re-edit any
 * element without copying the whole FigureContract into every shape; the
 * slide-level payload (compact, versioned) preserves the semantic graph —
 * including spatially-encoded and suppressed relations — so a reopened deck
 * can recover the real FigureGraph instead of guessing from visuals.
 */
import type { SemanticMetadata } from '@genoffice/pptx-engine'
import type {
  ResearchFigureSlidePayload,
  ResearchNodeRecord,
  ResearchRelationRecord,
} from '@genoffice/pptx-engine/research-metadata'
import { RESEARCH_METADATA_VERSION } from '@genoffice/pptx-engine/identity'
import { componentThemeTokens } from '@genoffice/theme-engine'
import type { RoutedEdge } from '@genoffice/research-harness'

function themeTokensFor(kind: string): { themeFill: string; themeStroke: string; themeText: string } {
  const tokens = componentThemeTokens(kind)
  return { themeFill: tokens.fill, themeStroke: tokens.stroke, themeText: tokens.text }
}

export interface FigureIdentity {
  figureRunId: string
  figureFamily: string
  domain: string
}

export function figureIdentity(parts: {
  figureFamily?: string
  domain?: string
}): FigureIdentity {
  return {
    figureRunId: `fig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    figureFamily: parts.figureFamily || 'unspecified',
    domain: parts.domain || 'general',
  }
}

interface BaseMetadataArgs extends FigureIdentity {
  semanticNodeId?: string
  visualUnitId?: string
  parentModuleId?: string
  evidenceRefs?: string
  provenanceRefs?: string
}

/** A parent module shape (macro node / container). */
export function moduleMetadata(args: BaseMetadataArgs & { primitiveKind: string }): SemanticMetadata {
  return {
    role: args.primitiveKind,
    ...themeTokensFor(args.primitiveKind),
    componentType: 'research-module',
    researchMetadataVersion: RESEARCH_METADATA_VERSION,
    ...(args.semanticNodeId ? { semanticNodeId: args.semanticNodeId } : {}),
    figureRunId: args.figureRunId,
    figureFamily: args.figureFamily,
    domain: args.domain,
    primitiveKind: args.primitiveKind,
    ...(args.evidenceRefs ? { evidenceRefs: args.evidenceRefs } : {}),
    ...(args.provenanceRefs ? { provenanceRefs: args.provenanceRefs } : {}),
  }
}

/** A micro unit shape inside a composite module — inherits the module identity. */
export function microUnitMetadata(
  args: BaseMetadataArgs & { primitiveKind: string },
): SemanticMetadata {
  return {
    ...moduleMetadata(args),
    componentType: 'research-micro',
    ...(args.parentModuleId ? { parentModuleId: args.parentModuleId } : {}),
    ...(args.visualUnitId ? { visualUnitId: args.visualUnitId } : {}),
  }
}

/** A connector shape bound to one semantic edge. */
export function connectorMetadata(
  args: BaseMetadataArgs & {
    semanticEdgeId: string
    relationType: string
    relationPresentation: string
  },
): SemanticMetadata {
  return {
    role: 'research-connector',
    themeFill: 'none',
    themeStroke: 'connector',
    themeText: 'none',
    componentType: 'research-connector',
    researchMetadataVersion: RESEARCH_METADATA_VERSION,
    semanticEdgeId: args.semanticEdgeId,
    relationType: args.relationType,
    relationPresentation: args.relationPresentation,
    figureRunId: args.figureRunId,
    figureFamily: args.figureFamily,
    domain: args.domain,
  }
}

const RENDERED_PRESENTATIONS = new Set([
  'arrow',
  'line',
  'dashed-arrow',
  'inhibition',
  'feedback-loop',
  'junction',
])

/** Relation status → slide-payload record (RENDER-P0-10: nothing is forgotten). */
export function relationRecords(
  edges: Array<{
    id?: string
    from: string
    to: string
    relation: string
    presentation?: string
    key: string
  }>,
  routes: RoutedEdge[],
  connectorIdByEdgeId: Map<string, string>,
): ResearchRelationRecord[] {
  const routedById = new Map(
    routes.filter((r) => r.semanticEdgeId).map((r) => [r.semanticEdgeId!, r]),
  )
  return edges.map((edge) => {
    const id = edge.id ?? edge.key
    const presentation = edge.presentation ?? 'arrow'
    const route = routedById.get(id)
    if (RENDERED_PRESENTATIONS.has(presentation)) {
      if (route?.status === 'routed') {
        // Native connector id joins later (post-materialization) via the
        // per-shape semanticEdgeId on the connector element itself.
        const connectorId = connectorIdByEdgeId.get(id)
        return {
          id,
          from: edge.from,
          to: edge.to,
          relation: edge.relation,
          presentation,
          status: 'rendered' as const,
          ...(connectorId ? { connectorId } : {}),
        }
      }
      return {
        id,
        from: edge.from,
        to: edge.to,
        relation: edge.relation,
        presentation,
        status: 'suppressed' as const,
        reason: route?.status === 'unroutable' ? (route.diagnostic ?? 'unroutable') : 'connector not bound',
      }
    }
    return {
      id,
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      presentation,
      status: 'spatial' as const,
      reason: `relation expressed through ${presentation} rather than a connector`,
    }
  })
}

export function slidePayload(args: {
  identity: FigureIdentity
  thesis: string
  nodes: ResearchNodeRecord[]
  relations: ResearchRelationRecord[]
  typography?: { fontScale: number; measurer: string }
}): ResearchFigureSlidePayload {
  return {
    schemaVersion: 1,
    figureRunId: args.identity.figureRunId,
    figureFamily: args.identity.figureFamily,
    domain: args.identity.domain,
    thesis: args.thesis,
    nodes: args.nodes,
    relations: args.relations,
    ...(args.typography ? { typography: args.typography } : {}),
  }
}
