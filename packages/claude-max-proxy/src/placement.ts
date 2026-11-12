/**
 * placement — переехал в SDK (`@life-ai-tools/claude-code-sdk`, `src/placement.ts`), 12.11.2026.
 *
 * Один алгоритм выбора организации на ВСЕ двери: OpenDesign/Go здесь, Anthropic в SDK
 * (выбор при рождении сессии). Копия здесь означала бы два балансировщика, которые
 * расходятся молча — ровно то, что фаундер попросил не допустить.
 */
export {
  assessOrg, planPlacement, placementInputs, NEAR_WALL_HOURS,
  type PlacementWindow, type PlacementOrg, type PlacementAssessment, type PlacementPlan,
} from '@life-ai-tools/claude-code-sdk'
