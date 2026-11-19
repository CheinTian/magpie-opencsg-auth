// Loads the plugin the way magpie does and validates its hook shape without
// making a network request.
const mod = await import(new URL("../index.mjs", import.meta.url).href)
const magpie = await import(new URL("../magpie.mjs", import.meta.url).href)
const problems = []
const expectedTools = [
  "opencsg_models",
  "opencsg_generate_image",
  "opencsg_generate_video",
  "opencsg_video_status",
  "opencsg_system_one",
]
const fns = Object.entries(mod).filter(
  ([name, value]) => name !== "_internal" && name !== "default" && typeof value === "function",
)

const openCodePlugin = mod.default
if (!openCodePlugin || typeof openCodePlugin !== "object") {
  problems.push("default: no OpenCode v2 plugin definition")
} else {
  if (typeof openCodePlugin.id !== "string" || !openCodePlugin.id) problems.push("default: id")
  if (typeof openCodePlugin.setup !== "function") problems.push("default: setup")
}

if (typeof magpie.OpenCSGAuthPlugin !== "function") {
  problems.push("magpie: no OpenCSGAuthPlugin function")
}

if (!fns.length) problems.push("exports no plugin function")

for (const [name, fn] of fns) {
  const hooks = await fn({ client: { auth: { set: async () => {} } } })
  const auth = hooks?.auth
  if (!auth) {
    problems.push(`${name}: no auth hook`)
    continue
  }
  if (typeof auth.provider !== "string" || !auth.provider) problems.push(`${name}: auth.provider`)
  if (typeof auth.loader !== "function") problems.push(`${name}: auth.loader`)
  if (!Array.isArray(auth.methods) || !auth.methods.length) problems.push(`${name}: auth.methods`)
  for (const method of auth.methods ?? []) {
    if (method.type !== "api" && method.type !== "oauth") {
      problems.push(`${name}: auth method type ${method.type}`)
    }
    if (method.type === "oauth" && typeof method.authorize !== "function") {
      problems.push(`${name}: oauth method has no authorize`)
    }
  }
  if (hooks.config) {
    const cfg = { provider: {} }
    await hooks.config(cfg)
    const p = cfg.provider[auth.provider]
    if (!p?.npm || !p?.models || !Object.keys(p.models).length) {
      problems.push(`${name}: config gives ${auth.provider} no npm or models`)
    }
    if (!p?.chat) problems.push(`${name}: provider has no Chat Completions endpoint`)
    if (!p?.anthropic) problems.push(`${name}: provider has no Anthropic endpoint`)
    if (!p?.responses) problems.push(`${name}: provider has no Responses endpoint`)
    if (p?.decide !== true) problems.push(`${name}: provider does not enable System One`)
    if (!p?.decideURL) problems.push(`${name}: provider has no System One endpoint`)
    if (!p?.baseAPI) problems.push(`${name}: provider has no default protocol`)
    for (const model of Object.values(p?.models ?? {})) {
      if (!Array.isArray(model?.also) || !model.also.includes("@ai-sdk/anthropic")) {
        problems.push(`${name}: a model does not advertise Anthropic Messages`)
      }
      if (!model.also.includes("@ai-sdk/openai")) {
        problems.push(`${name}: a model does not advertise OpenAI Responses`)
      }
    }
  }
  for (const tool of expectedTools) {
    const def = hooks.tool?.[tool]
    if (!def) {
      problems.push(`${name}: missing tool ${tool}`)
      continue
    }
    if (!def.args || def.args.type !== "object") problems.push(`${name}: ${tool} args`)
    if (typeof def.execute !== "function") problems.push(`${name}: ${tool} execute`)
  }
}

if (problems.length) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log("✓ opencsg")
