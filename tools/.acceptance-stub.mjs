// e2e/helpers/stub-provider.ts
import { createServer } from "node:http";
var FIGURE_PLAN = {
  thesis: "E2E: \u5E95\u7269\u7ECF\u4E24\u6B65\u9176\u4FC3\u53CD\u5E94\u751F\u6210\u4EA7\u7269",
  figureType: "input-core-output",
  narrative: {
    expressionMode: "mechanism",
    complexity: "compact",
    centralMessage: "\u4E24\u6B65\u9176\u4FC3\u53CD\u5E94\u751F\u6210\u4EA7\u7269",
    visualCenter: "e1",
    mustShow: ["sub", "e1", "e2", "out"],
    mayMerge: [],
    omitFromCanvas: []
  },
  primarySpine: ["sub", "e1", "e2", "out"],
  nodes: [
    {
      id: "sub",
      type: "data-source",
      semanticLabel: "\u5E95\u7269",
      visible: { title: "\u5E95\u7269" },
      importance: 0.4,
      role: "input"
    },
    {
      id: "e1",
      type: "mechanism",
      semanticLabel: "\u9176\u4FC3\u53CD\u5E94\u4E00",
      visible: { title: "\u9176\u4FC3\u53CD\u5E94\u4E00" },
      importance: 0.9,
      role: "core"
    },
    {
      id: "e2",
      type: "mechanism",
      semanticLabel: "\u9176\u4FC3\u53CD\u5E94\u4E8C",
      visible: { title: "\u9176\u4FC3\u53CD\u5E94\u4E8C" },
      importance: 0.7,
      role: "core"
    },
    {
      id: "out",
      type: "outcome",
      semanticLabel: "\u4EA7\u7269",
      visible: { title: "\u4EA7\u7269" },
      importance: 0.6,
      role: "output"
    }
  ],
  edges: [
    { id: "r1", from: "sub", to: "e1", role: "main", relation: "process" },
    { id: "r2", from: "e1", to: "e2", role: "main", relation: "process" },
    { id: "r3", from: "e2", to: "out", role: "main", relation: "transformation" }
  ],
  groups: [],
  globalIntent: { emphasis: ["e1"], secondary: [], optional: [] },
  readingIntent: { preferredDirection: "LR" }
};
var SPATIAL_PLAN = {
  composition: {
    readingFlow: "LR",
    balance: "asymmetric",
    density: "medium",
    visualCenter: "e1",
    whitespaceStrategy: "balanced"
  },
  placements: [
    { id: "sub", boxHint: { x: 0.05, y: 0.38, w: 0.17, h: 0.24 }, visualRole: "primary" },
    { id: "e1", boxHint: { x: 0.32, y: 0.32, w: 0.24, h: 0.36 }, visualRole: "dominant" },
    { id: "e2", boxHint: { x: 0.63, y: 0.34, w: 0.2, h: 0.3 }, visualRole: "primary" },
    { id: "out", boxHint: { x: 0.86, y: 0.4, w: 0.12, h: 0.2 }, visualRole: "secondary" }
  ]
};
function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}

`);
}
function textFrames(res, text) {
  sse(res, { id: "stub", choices: [{ delta: { role: "assistant", content: text } }] });
  sse(res, { id: "stub", choices: [{ delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}
function toolCallFrames(res, name, args) {
  sse(res, {
    id: "stub",
    choices: [
      {
        delta: {
          role: "assistant",
          tool_calls: [
            { index: 0, id: "stub_call_1", function: { name, arguments: JSON.stringify(args) } }
          ]
        }
      }
    ]
  });
  sse(res, { id: "stub", choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content.map((part) => typeof part?.text === "string" ? part.text : "").join(" ");
      if (text.trim()) return text;
    }
  }
  return "\u4E24\u6B65\u9176\u4FC3\u53CD\u5E94";
}
async function startStubProvider() {
  const requests = [];
  const server = createServer((req, res) => {
    if (!(req.url ?? "").includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        textFrames(res, "{}");
        return;
      }
      const messages = parsed.messages ?? [];
      const system = messages.find((message) => message.role === "system");
      const systemText = typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "");
      requests.push({
        hasTools: (parsed.tools?.length ?? 0) > 0,
        systemSnippet: systemText.slice(0, 120)
      });
      const hasTools = (parsed.tools?.length ?? 0) > 0;
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (hasTools) {
        if (hasToolResult) {
          textFrames(res, "\u7814\u7A76\u56FE\u5DF2\u901A\u8FC7 create_research_figure \u751F\u6210\u5B8C\u6BD5\u3002");
        } else {
          toolCallFrames(res, "create_research_figure", {
            thesis: lastUserText(messages).slice(0, 200),
            figureFamily: "mechanism",
            domain: "biomed",
            // deterministic stub = a well-calibrated spatial planner; unlocks the
            // A1 model-authored composition path so the declared boxHints drive
            // the solved geometry (and the edit spec can aim its dblclick)
            capability: {
              calibration: { spatialPlanning: "medium", jsonReliability: "high" }
            }
          });
        }
        return;
      }
      if (systemText.includes("SpatialPlan") || systemText.includes("Composition Designer")) {
        textFrames(res, `\`\`\`json
${JSON.stringify(SPATIAL_PLAN)}
\`\`\``);
        return;
      }
      textFrames(res, `\`\`\`json
${JSON.stringify(FIGURE_PLAN)}
\`\`\``);
    });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = server.address().port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise()))
  };
}
function aiSettingsJson(baseUrl) {
  return JSON.stringify({
    provider: "custom",
    providers: {
      custom: { apiKey: "stub-key", model: "stub-model", baseUrl }
    }
  });
}
export {
  aiSettingsJson,
  startStubProvider
};
