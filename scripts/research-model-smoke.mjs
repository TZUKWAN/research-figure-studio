// Research model smoke (QA-P1-15, manual/nightly only — never a PR gate).
// Calls the user-configured OpenAI-compatible endpoint with a fixed thesis and
// checks the structured planner contract: the model must return a parseable
// FigurePlanV2-shaped JSON object (thesis / nodes[] / edges[]). Exit 0 = pass.
// Config via env: METIS_SMOKE_BASE_URL, METIS_SMOKE_API_KEY, METIS_SMOKE_MODEL.

const BASE_URL = process.env.METIS_SMOKE_BASE_URL
const API_KEY = process.env.METIS_SMOKE_API_KEY
const MODEL = process.env.METIS_SMOKE_MODEL || 'gpt-4o-mini'

const THESIS =
  'Southern Ocean warming drives Antarctic krill swarm fragmentation, reducing penguin chick survival.'

function fail(message) {
  console.error(`[research-model-smoke] FAIL: ${message}`)
  process.exit(1)
}

const response = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You are the Semantic Planner of a research-figure pipeline. Output ONLY a JSON object: {"thesis":string,"figureType":string,"nodes":[{"id":string,"type":string,"semanticLabel":string,"visible":{"title":string},"importance":number,"role":string}],"edges":[{"from":string,"to":string,"role":string,"relation":string}]}. No prose.',
      },
      { role: 'user', content: `Thesis: ${THESIS}\nCanvas: 1280x720px` },
    ],
  }),
})

if (!response.ok) fail(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)

const data = await response.json()
const text = data?.choices?.[0]?.message?.content
if (typeof text !== 'string' || !text.trim()) fail('empty completion')

const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
const raw = (fenced ? fenced[1] : text).trim()
const start = raw.indexOf('{')
const end = raw.lastIndexOf('}')
if (start < 0 || end <= start) fail('no JSON object in completion')

let plan
try {
  plan = JSON.parse(raw.slice(start, end + 1))
} catch (error) {
  fail(`JSON parse error: ${error.message}`)
}

const nodeIds = new Set((plan.nodes ?? []).map((node) => node.id))
if (!plan.thesis || !Array.isArray(plan.nodes) || plan.nodes.length === 0) {
  fail('plan missing thesis or nodes[]')
}
if (!Array.isArray(plan.edges)) fail('plan missing edges[]')
for (const edge of plan.edges) {
  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
    fail(`edge references unknown node: ${edge.from} -> ${edge.to}`)
  }
}

console.log(
  `[research-model-smoke] PASS: model ${MODEL} produced a valid FigurePlan shape (${plan.nodes.length} nodes, ${plan.edges.length} edges)`,
)
