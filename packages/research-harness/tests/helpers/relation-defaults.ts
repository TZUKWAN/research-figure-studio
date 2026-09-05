import type { RelationPresentation, RelationType } from '../../src/semantic/schema.js'

/**
 * Independent oracle for relation→presentation defaults (mirrors the schema
 * contract on purpose so a regression in either side breaks this test).
 */
export function relationDefault(relation: RelationType): RelationPresentation {
  switch (relation) {
    case 'inhibition':
      return 'inhibition'
    case 'feedback':
      return 'feedback-loop'
    case 'moderation':
    case 'hypothesis':
      return 'dashed-arrow'
    case 'association':
    case 'mapping':
    case 'bidirectional':
      return 'line'
    case 'hierarchy':
      return 'containment'
    default:
      return 'arrow'
  }
}
