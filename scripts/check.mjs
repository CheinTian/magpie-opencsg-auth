// Loads the plugin the way magpie does and validates its hook shape without
// making a network request.
const mod = await import(new URL("../index.mjs", import.meta.url).href)
const problems = []
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
  }
}

if (problems.length) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log("✓ opencsg")
