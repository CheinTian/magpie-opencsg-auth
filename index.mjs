// OpenCSG AI Gateway as a magpie provider.
//
// OpenCSG's gateway is OpenAI-compatible. API keys created in the platform
// (they start with "gw-sk-") are sent as Bearer tokens; models and their
// capability metadata come from GET /v1/models. The same plugin also accepts
// a custom gateway base URL, which is useful for private CSGHub deployments.

import { createServer } from "node:http"

const PROVIDER = "opencsg"
const DEFAULT_BASE = "https://opencsg.com/aigateway/v1"
const DEFAULT_PORTAL = "https://opencsg.com"
const DEFAULT_IAM_AUTHORIZE = "https://iam.opencsg.com/login/oauth/authorize"
const DEFAULT_IAM_CLIENT_ID = "d623c957e69976c8a7a8"
const DEFAULT_IAM_CALLBACK = "https://opencsg.com/api/v1/callback/casdoor"
// OpenCSG's portal OAuth callback forwards the signed JWT to one of three
// places: the portal itself (`state=casdoor`), a flow callback registered in
// OPENCSG_USER_SERVER_FLOW_REDIRECTS (`state=<https URL>`), or the built-in
// "lite" target (`state=lite` → OPENCSG_USER_SERVER_LITE_REDIRECT_URL).
// A bare localhost URL in `state` matches none of them, so CSGHub answers
// with opencsg.com/errors/server-error?error_code=500 - the 500 this plugin
// used to hit. An app that cannot be registered on the platform must
// therefore sign in with `state=lite` and receive the fixed loopback callback.
const SIGNIN_STATE = "lite"
const DEFAULT_SIGNIN_CALLBACK = "http://127.0.0.1:11437/api/cloud/auth/callback"
const NPM = "@ai-sdk/openai-compatible"
// magpie reads these AI SDK package names as the other native protocols a
// plugin model serves. Advertising them lets magpie offer per-key protocol
// selection and relay Anthropic Messages / Responses requests as sent.
const ALTERNATE_PROTOCOLS = ["@ai-sdk/anthropic", "@ai-sdk/openai"]
const OPENCODE_NPM = "@opencode/ai/providers/openai-compatible"
const PLUGIN_ID = "magpie-opencsg-auth"
const CLIENT_HEADER = "opencsg-magpie/0.1.7"
const TIMEOUT_MS = 20_000
const TOOL_TIMEOUT_MS = 45_000
const OAUTH_TIMEOUT_MS = 10 * 60_000
const MAX_PAGES = 20
const DEFAULT_MAGPIE_GATEWAY = "http://127.0.0.1:3425/v1"

const ACCOUNT_PROTOCOLS = new Set(["anthropic", "chat", "responses"])
const PROTOCOL_LABELS = {
  anthropic: "Anthropic Messages",
  chat: "Chat Completions",
  responses: "OpenAI Responses",
}

const IMAGE_TASKS = new Set(["text-to-image", "image-to-image"])
const VIDEO_TASKS = new Set([
  "text-to-video",
  "text-to-video-synthesis",
  "image-to-video",
  "audio-text-to-video",
  "audio-image-text-to-video",
])

// A conservative fallback used before the live list can be read. The gateway
// exposes many more models; provider.models replaces this list when live data
// is available. Keep only stable, generally available IDs here.
const FALLBACK_MODELS = {
  auto: {
    name: "Auto",
    limit: { context: 200_000, output: 32_000 },
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    also: ALTERNATE_PROTOCOLS,
  },
}

// magpie's provider hook can read the account's full OpenCSG catalog. Tool
// calls run later, in the same plugin process, so keep that catalog here to
// avoid asking for a credential the tool hook does not receive.
const catalogCache = {
  base: "",
  endpoints: undefined,
  items: [],
  at: 0,
}

// The config hook runs before the auth loader in magpie's host. Keep the
// configured System One URL for credentials that predate the sign-in prompt.
const endpointSettings = {
  systemOneURL: "",
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const text = (v) => (typeof v === "string" ? v.trim() : "")
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const positive = (v) => {
  const n = finite(v)
  return n !== undefined && n > 0 ? n : undefined
}

function normalizeBase(value) {
  const raw = text(value)
  if (!raw) return DEFAULT_BASE
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error("OpenCSG gateway URL must be an absolute http(s) URL")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenCSG gateway URL must use http or https")
  }
  let path = url.pathname.replace(/\/+$/, "")
  path = path.replace(/\/aigateway\/?$/i, "/aigateway/v1")
  if (!/\/v1$/i.test(path)) path += "/v1"
  url.pathname = path
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

function protocolEndpoints(gateway = DEFAULT_BASE) {
  const chat = normalizeBase(gateway)
  return {
    chat,
    // Anthropic SDKs append /v1/messages to their base URL.
    anthropic: chat.replace(/\/v1$/i, ""),
    // OpenAI Responses and System One both use the gateway's /v1 base.
    responses: chat,
    decide: chat,
  }
}

function normalizeAccountProtocol(value) {
  const protocol = text(value).toLowerCase()
  return ACCOUNT_PROTOCOLS.has(protocol) ? protocol : ""
}

// requestProtocol reads the native API a request is written for. System One
// and other gateway extensions deliberately return "".
function requestProtocol(input) {
  let pathname
  try {
    pathname = new URL(input instanceof Request ? input.url : String(input)).pathname
  } catch {
    return ""
  }
  const path = pathname.toLowerCase().replace(/\/+$/, "")
  if (/(^|\/)chat\/completions$/.test(path) || /(^|\/)completions$/.test(path)) return "chat"
  if (/(^|\/)messages(?:\/count_tokens)?$/.test(path)) return "anthropic"
  if (/(^|\/)responses$/.test(path)) return "responses"
  return ""
}

function normalizeSystemOne(value, gateway = DEFAULT_BASE) {
  const raw = text(value)
  if (!raw) return protocolEndpoints(gateway).decide

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error("System One URL must be an absolute http(s) URL")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("System One URL must use http or https")
  }

  let path = url.pathname.replace(/\/+$/, "")
  path = path.replace(/\/systemone$/i, "")
  path = path.replace(/\/aigateway\/?$/i, "/aigateway/v1")
  if (!/\/v1$/i.test(path)) path += "/v1"
  url.pathname = path
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

function availableEndpoints(gateway = DEFAULT_BASE, systemOne) {
  return {
    ...protocolEndpoints(gateway),
    decide: normalizeSystemOne(systemOne, gateway),
  }
}

function configureProviderEndpoints(provider) {
  const current = text(provider.chat) || text(provider.api) || DEFAULT_BASE
  let endpoints
  try {
    endpoints = protocolEndpoints(current)
  } catch {
    endpoints = protocolEndpoints(DEFAULT_BASE)
  }

  provider.api = text(provider.api) || endpoints.chat
  provider.chat = text(provider.chat) || endpoints.chat
  if (provider.anthropic === undefined) provider.anthropic = endpoints.anthropic
  if (provider.responses === undefined) provider.responses = endpoints.responses
  // magpie's plugin host enables System One only for the boolean `true`.
  // Keep the endpoint beside it so it stays visible and editable rather than
  // replacing the flag with a string the host would read as disabled.
  const configuredSystemOne = text(provider.decide)
  const explicitSystemOne = text(provider.decideURL) || configuredSystemOne
  if (provider.decide === undefined || provider.decide === true || configuredSystemOne) {
    const candidate = text(provider.decideURL) || configuredSystemOne || endpoints.decide
    provider.decide = true
    try {
      provider.decideURL = normalizeSystemOne(candidate, endpoints.chat)
    } catch {
      provider.decideURL = endpoints.decide
    }
    // A generated decideURL is only a visible default. Keep overriding it only
    // when the user explicitly configured one; otherwise a custom account
    // gateway must also supply the System One endpoint.
    endpointSettings.systemOneURL = explicitSystemOne ? provider.decideURL : ""
  } else {
    endpointSettings.systemOneURL = ""
  }
  provider.baseAPI ||= "chat"
}

function gatewayOf(auth) {
  return normalizeBase(auth?.metadata?.baseURL)
}

function portalOf(base) {
  return new URL(normalizeBase(base)).origin
}

function modelsURL(base) {
  return `${base}/models?page=1&per=100`
}

function magpieGatewayBase() {
  const configured = text(process.env.MAGPIE_GATEWAY_URL)
  if (configured) return normalizeBase(configured)
  const address = text(process.env.MAGPIE_ADDR)
  if (!address) return DEFAULT_MAGPIE_GATEWAY
  const url = /^https?:\/\//i.test(address) ? address : `http://${address}`
  return normalizeBase(url)
}

function safeJSON(value) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function responseErrorFromBody(res, body) {
  const parsed = safeJSON(body)
  const message =
    text(parsed?.error?.message) ||
    text(parsed?.msg) ||
    text(parsed?.message) ||
    text(parsed?.error) ||
    body.slice(0, 300) ||
    res.statusText ||
    "request failed"
  return `OpenCSG answered ${res.status}: ${message}`
}

async function responseError(res) {
  return responseErrorFromBody(res, await res.text().catch(() => ""))
}

function requestSignal(signal, timeout = TOOL_TIMEOUT_MS) {
  const deadline = AbortSignal.timeout(timeout)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

async function apiRequest(base, key, path, options = {}) {
  const headers = new Headers(options.headers ?? {})
  headers.set("Accept", headers.get("Accept") ?? "application/json")
  headers.set("X-OpenCSG-Client", CLIENT_HEADER)
  if (key) headers.set("Authorization", `Bearer ${key}`)

  let body
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json")
    body = JSON.stringify(options.body)
  }

  const res = await fetch(`${normalizeBase(base)}${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
    signal: requestSignal(options.signal, options.timeout),
  })
  const raw = await res.text().catch(() => "")
  if (!res.ok) throw new Error(responseErrorFromBody(res, raw))
  if (!raw) return undefined

  const parsed = safeJSON(raw)
  if (parsed !== undefined) return parsed
  if ((res.headers.get("Content-Type") ?? "").includes("application/json")) {
    throw new Error("OpenCSG answered with malformed JSON")
  }
  return raw
}

async function validateKey(base, key, signal) {
  const res = await fetch(modelsURL(base), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
    },
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(await responseError(res))
  await res.body?.cancel().catch(() => {})
}

function parseJWTPayload(token) {
  const parts = text(token).split(".")
  if (parts.length !== 3) throw new Error("OpenCSG returned an invalid sign-in token")
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
    const claims = JSON.parse(new TextDecoder().decode(bytes))
    const username = text(claims?.current_user)
    const uuid = text(claims?.uuid)
    if (!username || !uuid) throw new Error("missing user claims")
    return { username, uuid }
  } catch {
    throw new Error("OpenCSG returned an invalid sign-in token")
  }
}

function keyFromPayload(value) {
  if (typeof value === "string") return text(value)
  if (!isObject(value)) return ""
  for (const key of ["token", "key", "access_token", "api_key"]) {
    const found = text(value[key])
    if (found) return found
  }
  for (const key of ["data", "result"]) {
    const found = keyFromPayload(value[key])
    if (found) return found
  }
  return ""
}

const BASE_URL_PROMPT = {
  type: "text",
  key: "baseURL",
  message: "Gateway URL",
  placeholder: DEFAULT_BASE,
  validate: (value) => {
    if (!text(value)) return undefined
    try {
      normalizeBase(value)
      return undefined
    } catch (e) {
      return e.message
    }
  },
}

const SYSTEM_ONE_PROMPT = {
  type: "text",
  key: "systemOneURL",
  message: "System One URL",
  placeholder: DEFAULT_BASE,
  validate: (value) => {
    if (!text(value)) return undefined
    try {
      normalizeSystemOne(value)
      return undefined
    } catch (e) {
      return e.message
    }
  },
}

const ACCOUNT_PROTOCOL_PROMPT = {
  type: "select",
  key: "protocol",
  message: "Protocol this account uses",
  options: [
    { label: "Any protocol", value: "", hint: "Use this account on every OpenCSG endpoint" },
    { label: "Anthropic Messages", value: "anthropic", hint: "Claude Code and Anthropic SDK clients" },
    { label: "Chat Completions", value: "chat", hint: "Most OpenAI-compatible clients" },
    { label: "OpenAI Responses", value: "responses", hint: "Codex and OpenAI Responses clients" },
  ],
}

const AUTH_PROMPTS = [BASE_URL_PROMPT, SYSTEM_ONE_PROMPT, ACCOUNT_PROTOCOL_PROMPT]

function authMethod(type, label) {
  return {
    type,
    label,
    placeholder: type === "api" ? "gw-sk-…" : "",
    prompts: AUTH_PROMPTS,
  }
}

async function discoverAuthorizeURL(portal, signal) {
  const login = new URL("/login", portal)
  try {
    const res = await fetch(login, {
      redirect: "manual",
      headers: { Accept: "text/html" },
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    })
    const location = text(res.headers.get("location"))
    if (!location) return undefined
    const authorize = new URL(location, login)
    if (authorize.protocol !== "https:" && authorize.protocol !== "http:") {
      throw new Error("OpenCSG returned an invalid sign-in URL")
    }
    // /login publishes state=casdoor, which only signs the browser into the
    // portal. Ask the user service to send the sign-in to the local target.
    authorize.searchParams.set("state", SIGNIN_STATE)
    return authorize.toString()
  } catch {
    return undefined
  }
}

function fallbackAuthorizeURL() {
  const authorize = new URL(DEFAULT_IAM_AUTHORIZE)
  authorize.searchParams.set("client_id", DEFAULT_IAM_CLIENT_ID)
  authorize.searchParams.set("response_type", "code")
  authorize.searchParams.set("redirect_uri", DEFAULT_IAM_CALLBACK)
  authorize.searchParams.set("scope", "read")
  authorize.searchParams.set("state", SIGNIN_STATE)
  return authorize.toString()
}

async function authorizeURL(portal, signal) {
  const discovered = await discoverAuthorizeURL(portal, signal)
  if (discovered) return discovered
  if (portal === DEFAULT_PORTAL) return fallbackAuthorizeURL()
  throw new Error("Could not start OpenCSG sign-in for this gateway")
}

function callbackPage(ok) {
  const title = ok ? "OpenCSG sign-in complete" : "OpenCSG sign-in failed"
  const message = ok
    ? "You can close this window and return to magpie."
    : "Return to magpie and start sign-in again."
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`
}

// signInCallbackURL is where the platform sends the signed JWT. It mirrors
// OPENCSG_USER_SERVER_LITE_REDIRECT_URL, which defaults to a loopback target
// reserved for local apps; a deployment that changed it can point the plugin
// at the new value with OPENCSG_SIGNIN_CALLBACK.
function signInCallbackURL() {
  const configured = text(process.env.OPENCSG_SIGNIN_CALLBACK)
  let url
  try {
    url = new URL(configured || DEFAULT_SIGNIN_CALLBACK)
  } catch {
    throw new Error("OPENCSG_SIGNIN_CALLBACK must be an absolute http URL")
  }
  if (url.protocol !== "http:") {
    throw new Error("OPENCSG_SIGNIN_CALLBACK must use http; the platform's lite callback is loopback")
  }
  url.search = ""
  url.hash = ""
  return url
}

function localCallback(path, finish, done) {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("Content-Type", "text/html; charset=utf-8")

    if (req.method !== "GET" || url.pathname !== path) {
      res.statusCode = 404
      res.end(callbackPage(false))
      return
    }

    // The lite target carries the signed CSGHub JWT as `jwt`; older or
    // re-routed deployments may still call it `jwt_token`.
    const jwt = text(url.searchParams.get("jwt")) || text(url.searchParams.get("jwt_token"))
    if (!jwt) {
      const reason =
        text(url.searchParams.get("error_message")) ||
        text(url.searchParams.get("error")) ||
        "OpenCSG did not return a sign-in token. Try again."
      res.statusCode = 400
      res.end(callbackPage(false))
      if (!done()) finish({ error: new Error(reason) })
      return
    }

    res.statusCode = 200
    res.end(callbackPage(true))
    if (!done()) finish({ jwt })
  }
}

async function callbackServer() {
  const callback = signInCallbackURL()
  const port = callback.port ? Number(callback.port) : 80
  let finish
  let done = false
  const completion = new Promise((resolve) => {
    finish = resolve
  })

  const server = createServer(
    localCallback(callback.pathname, finish, () => {
      if (done) return true
      done = true
      return false
    }),
  )

  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      reject(
        error?.code === "EADDRINUSE"
          ? new Error(
              `${callback.host} port ${port} is already in use. Stop the other local OpenCSG ` +
                "sign-in listener (csghub-lite listens on the same target) and try again.",
            )
          : error,
      )
    })
    server.listen(port, callback.hostname, resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("Could not start the local OpenCSG sign-in listener")
  }

  const timer = setTimeout(() => {
    if (done) return
    done = true
    finish({
      error: new Error(
        `OpenCSG sign-in timed out without reaching ${callback.href}. ` +
          "The platform sends the lite callback to OPENCSG_USER_SERVER_LITE_REDIRECT_URL; " +
          "set OPENCSG_SIGNIN_CALLBACK to that URL if the deployment changed it.",
      ),
    })
    server.close()
  }, OAUTH_TIMEOUT_MS)
  timer.unref?.()

  return {
    callbackURL: callback.toString(),
    completion,
    close() {
      clearTimeout(timer)
      server.close()
    },
  }
}

async function keyForJWT(jwt, base, signal) {
  const claims = parseJWTPayload(jwt)
  const api = `${portalOf(base)}/api/v1`
  const endpoints = [
    `${api}/namespaces/${encodeURIComponent(claims.uuid)}/apikeys/builtin`,
    `${api}/user/${encodeURIComponent(claims.username)}/tokens/first?app=aigateway&token_name=magpie`,
  ]
  const errors = []
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await res.text().catch(() => "")
    if (!res.ok) {
      const parsed = safeJSON(body)
      errors.push(`OpenCSG answered ${res.status}: ${text(parsed?.msg) || text(parsed?.message) || body.slice(0, 300) || res.statusText}`)
      continue
    }
    const key = keyFromPayload(safeJSON(body) ?? body)
    if (key) return { key, claims }
    errors.push(`OpenCSG answered ${res.status} without an API key`)
  }
  throw new Error(errors.join("; ") || "OpenCSG did not return an AI Gateway key")
}

async function readModels(base, key, signal) {
  const out = []
  const seen = new Set()
  let cursor = ""
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(modelsURL(base))
    if (cursor) url.searchParams.set("after", cursor)
    const headers = { Accept: "application/json" }
    if (key) headers.Authorization = `Bearer ${key}`
    const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(await responseError(res))
    const body = await res.json()
    const data = Array.isArray(body?.data) ? body.data : []
    for (const item of data) {
      const id = text(item?.id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(item)
    }
    if (body?.has_more !== true) break
    const next = text(body?.last_id) || text(data.at(-1)?.id)
    if (!next || next === cursor) break
    cursor = next
  }
  return out
}

function tasksOf(model) {
  const tasks = new Set()
  for (const value of [model?.task, ...(Array.isArray(model?.metadata?.tasks) ? model.metadata.tasks : [])]) {
    if (typeof value !== "string") continue
    for (const task of value.split(",")) if (task.trim()) tasks.add(task.trim())
  }
  return tasks
}

function isDecisionModel(model) {
  const tasks = tasksOf(model)
  if (
    tasks.has("typed-decisions") ||
    tasks.has("decision-model") ||
    tasks.has("systemone") ||
    tasks.has("system-one")
  ) {
    return true
  }
  return tasks.has("decision") && !tasks.has("text-generation")
}

function isImageModel(model) {
  const tasks = tasksOf(model)
  return [...tasks].some((task) => IMAGE_TASKS.has(task))
}

function isVideoModel(model) {
  const tasks = tasksOf(model)
  return [...tasks].some((task) => VIDEO_TASKS.has(task))
}

function supportsChat(model) {
  const tasks = tasksOf(model)
  if (isDecisionModel(model) || isImageModel(model) || isVideoModel(model)) return false
  return tasks.size === 0 || tasks.has("text-generation") || tasks.has("image-text-to-text")
}

function modelKind(model) {
  if (isDecisionModel(model)) return "decision"
  if (isImageModel(model)) return "image"
  if (isVideoModel(model)) return "video"
  if (supportsChat(model)) return "chat"
  return undefined
}

function modelKinds(model) {
  const out = []
  if (isDecisionModel(model)) out.push("decision")
  if (isImageModel(model)) out.push("image")
  if (isVideoModel(model)) out.push("video")
  if (supportsChat(model)) out.push("chat")
  return out
}

function pricingOf(model) {
  const p = model?.metadata?.pricing
  if (!isObject(p)) return undefined
  const input = positive(p.input_token_price?.price_per_million)
  const output = positive(p.output_token_price?.price_per_million)
  const cacheRead = positive(p.input_token_price?.cached_price_per_million)
  if (input === undefined && output === undefined && cacheRead === undefined) return undefined

  // OpenCSG publishes CNY prices. OpenCode/magpie model costs are in USD per
  // million tokens, so convert them with the gateway's published rate metadata
  // when present, else with a conservative fixed rate. The exact local invoice
  // remains authoritative; this is for estimates and routing only.
  const currency = text(p.input_token_price?.currency) || text(p.output_token_price?.currency) || "CNY"
  const rate = currency === "USD" || currency === "$" ? 1 : 7.2
  return {
    input: (input ?? 0) / rate,
    output: (output ?? 0) / rate,
    cache: { read: (cacheRead ?? 0) / rate, write: 0 },
  }
}

function labelOf(id) {
  const last = id.split("/").at(-1) || id
  return last
    .replace(/[_-]+/g, " ")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Glm|Asr|Llm|Ocr|Api)\b/g, (m) => m.toUpperCase())
}

function modelOf(item, provider) {
  const id = text(item?.id)
  const tasks = tasksOf(item)
  const kind = modelKind(item)
  const images =
    tasks.has("image-text-to-text") ||
    tasks.has("image-to-image") ||
    item?.metadata?.is_vision_model === true
  const output =
    kind === "image" ? ["image"] : kind === "video" ? ["video"] : ["text"]
  const toolCall = kind === "chat" && item?.support_function_call === true
  const available = item?.availability?.is_available !== false
  const previous = provider?.models?.[id] ?? {}
  const name = text(item?.name) || text(item?.metadata?.display_name) || labelOf(id)
  const context = positive(item?.context_length) ?? positive(item?.metadata?.context_length) ?? previous.limit?.context ?? 0
  const outputLimit =
    positive(item?.max_output_tokens) ??
    positive(item?.metadata?.max_output_tokens) ??
    positive(previous.limit?.output) ??
    0
  const pricing = pricingOf(item)

  const model = {
    ...previous,
    id,
    name,
    api: { id, npm: NPM },
    limit: { context, output: outputLimit },
    tool_call: toolCall,
    attachment: images,
    modalities: { input: images ? ["text", "image"] : ["text"], output },
    capabilities: {
      temperature: kind === "chat",
      reasoning: false,
      toolcall: toolCall,
      attachment: images,
      input: { text: true, image: images },
      output: {
        text: output.includes("text"),
        image: output.includes("image"),
        video: output.includes("video"),
      },
    },
    ...(kind === "chat" ? { also: ALTERNATE_PROTOCOLS } : {}),
    ...(kind ? { kind } : {}),
    ...(kind === "decision" ? { decides: true } : {}),
    ...(pricing ? { cost: pricing } : {}),
    ...(available ? {} : { status: "deprecated" }),
  }
  return model
}

function liveModels(items, provider) {
  const models = {}
  for (const item of items) {
    if (!modelKind(item)) continue
    const m = modelOf(item, provider)
    if (m.id) models[m.id] = m
  }
  return models
}

function withoutProvider(id) {
  const value = text(id)
  const prefix = `${PROVIDER}/`
  return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

function modelIsAvailable(model) {
  return model?.availability?.is_available !== false
}

function chooseModel(items, kind, requested) {
  const wanted = withoutProvider(requested)
  const usable = items.filter(modelIsAvailable)

  if (wanted) {
    const found = usable.find((item) => withoutProvider(item?.id) === wanted)
    if (found) {
      if (!modelKinds(found).includes(kind)) {
        throw new Error(`OpenCSG model "${wanted}" is not a ${kind} model`)
      }
      return found
    }
    if (items.some((item) => withoutProvider(item?.id) === wanted)) {
      throw new Error(`OpenCSG model "${wanted}" is currently unavailable`)
    }
    // A cached catalog can be older than the account's permissions. An
    // explicitly named model is still sent through so the gateway decides.
    if (items.length === 0) return { id: wanted }
    const available = usable
      .filter((item) => modelKinds(item).includes(kind))
      .map((item) => text(item?.id))
      .filter(Boolean)
    throw new Error(
      `OpenCSG model "${wanted}" is not in this account's catalog` +
        (available.length ? `. Available ${kind} models: ${available.join(", ")}` : ""),
    )
  }

  const found = usable.find((item) => modelKinds(item).includes(kind))
  if (found) return found

  throw new Error(
    `No available OpenCSG ${kind} model was found in this account's catalog. ` +
      "Ask an OpenCSG administrator for access, or pass model explicitly.",
  )
}

function modelSummary(item) {
  return {
    id: text(item?.id),
    name: text(item?.name) || text(item?.metadata?.display_name) || text(item?.id),
    kinds: modelKinds(item),
    tasks: [...tasksOf(item)],
    available: modelIsAvailable(item),
  }
}

function gatewayModelItem(model) {
  const id = withoutProvider(model?.id)
  const outputs = Array.isArray(model?.modalities?.output) ? model.modalities.output : []
  let task = "text-generation"
  if (model?.decides === true) task = "typed-decisions"
  else if (outputs.includes("video")) task = "text-to-video"
  else if (outputs.includes("image")) task = "text-to-image"
  return {
    id,
    name: text(model?.display_name) || text(model?.name) || id,
    task,
    metadata: { tasks: [task] },
    availability: { is_available: true },
  }
}

function toolSignal(ctx, timeout = TOOL_TIMEOUT_MS) {
  const outer = ctx?.abort ?? ctx?.signal
  return requestSignal(outer, timeout)
}

function absoluteURL(connection, path) {
  return `${normalizeBase(connection.baseURL)}${path}`
}

function videoResult(connection, result) {
  const id = text(result?.id)
  const status = text(result?.status)
  return {
    ...result,
    ...(id && !text(result?.status_url)
      ? { status_url: absoluteURL(connection, `/videos/${encodeURIComponent(id)}`) }
      : {}),
    ...(id && status === "completed" && !text(result?.content_url)
      ? { content_url: absoluteURL(connection, `/videos/${encodeURIComponent(id)}/content`) }
      : {}),
  }
}

function systemOneBody(args) {
  const state = args?.state
  if (state === undefined || state === null) throw new Error("state is required")
  if (typeof state === "string" && !state.trim()) throw new Error("state cannot be empty")
  if (!isObject(args?.questions) || Object.keys(args.questions).length === 0) {
    throw new Error("questions must be a non-empty object of named typed questions")
  }

  const questions = {}
  for (const [name, question] of Object.entries(args.questions)) {
    if (!isObject(question)) throw new Error(`questions.${name} must be an object`)
    const type = text(question.type)
    if (!type) throw new Error(`questions.${name}.type is required`)
    if (type === "choice" && question.criteria === undefined) {
      throw new Error(`questions.${name}.criteria is required for choice questions`)
    }
    questions[name] = question
  }

  return { state, questions }
}

async function toolCatalog(runtime, ctx, requestedModel) {
  const signal = toolSignal(ctx)
  const connection = await runtime.connection(signal)
  try {
    return { connection, items: await runtime.catalog(connection, signal) }
  } catch (error) {
    if (requestedModel) return { connection, items: [] }
    throw new Error(
      `Could not discover OpenCSG models. Sign in again or pass model explicitly. ${error.message}`,
      { cause: error },
    )
  }
}

function createToolDefinitions(runtime) {
  return {
    opencsg_models: {
      description:
        "List OpenCSG models available to the signed-in account, grouped by chat, image, video and System One decision capability. Use this before choosing an optional media or decision model.",
      args: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["all", "chat", "image", "video", "decision"],
            default: "all",
          },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const kind = text(args?.kind) || "all"
        if (!["all", "chat", "image", "video", "decision"].includes(kind)) {
          throw new Error("kind must be all, chat, image, video or decision")
        }
        const signal = toolSignal(ctx)
        const connection = await runtime.connection(signal)
        const items = await runtime.catalog(connection, signal)
        const selected = items.filter(
          (item) => modelKinds(item).length && (kind === "all" || modelKinds(item).includes(kind)),
        )
        const groups = { chat: [], image: [], video: [], decision: [] }
        for (const item of selected) {
          for (const capability of modelKinds(item)) groups[capability].push(text(item.id))
        }
        return {
          kind,
          endpoints: runtime.endpoints?.(connection) ?? availableEndpoints(connection.baseURL),
          models: selected.map(modelSummary),
          groups,
        }
      },
    },

    opencsg_generate_image: {
      description:
        "Generate image URLs with OpenCSG's /images/generations endpoint. When model is omitted, the first available text-to-image model in the account catalog is used.",
      args: {
        type: "object",
        properties: {
          prompt: { type: "string", minLength: 1 },
          model: { type: "string", description: "Optional text-to-image model ID." },
          n: { type: "integer", minimum: 1, maximum: 10 },
          size: { type: "string", description: "Provider size such as 1024x1024." },
          response_format: { type: "string", enum: ["url", "b64_json"], default: "url" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const prompt = text(args?.prompt)
        if (!prompt) throw new Error("prompt is required")
        const { connection, items } = await toolCatalog(runtime, ctx, args?.model)
        const model = chooseModel(items, "image", args?.model)
        const body = {
          model: runtime.modelName(connection, model.id),
          prompt,
          response_format: text(args?.response_format) || "url",
        }
        if (args?.n !== undefined) {
          if (!Number.isInteger(args.n) || args.n < 1 || args.n > 10) {
            throw new Error("n must be an integer from 1 to 10")
          }
          body.n = args.n
        }
        if (text(args?.size)) body.size = text(args.size)

        const response = await runtime.request(connection, "/images/generations", {
          body,
          signal: toolSignal(ctx),
        })
        const images = Array.isArray(response?.data) ? response.data : []
        const urls = images.map((image) => text(image?.url) || text(image?.b64_json)).filter(Boolean)
        if (!images.length) throw new Error("OpenCSG returned no image data")
        return {
          model: withoutProvider(model.id),
          prompt,
          ...(body.n ? { n: body.n } : {}),
          ...(body.size ? { size: body.size } : {}),
          response_format: body.response_format,
          urls,
          images,
        }
      },
    },

    opencsg_generate_video: {
      description:
        "Create an asynchronous OpenCSG video generation with /videos. Returns the job ID and status URLs; poll with opencsg_video_status. An optional input image enables image-to-video models.",
      args: {
        type: "object",
        properties: {
          prompt: { type: "string", minLength: 1 },
          model: { type: "string", description: "Optional text-to-video or image-to-video model ID." },
          size: { type: "string", description: "Provider size such as 1280x720." },
          seconds: { type: "integer", minimum: 1, maximum: 60 },
          image_url: { type: "string", description: "Input image URL for image-to-video." },
          file_id: { type: "string", description: "OpenCSG uploaded-file ID for image-to-video." },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const prompt = text(args?.prompt)
        if (!prompt) throw new Error("prompt is required")
        const imageURL = text(args?.image_url)
        const fileID = text(args?.file_id)
        if (imageURL && fileID) throw new Error("Use image_url or file_id, not both")

        const { connection, items } = await toolCatalog(runtime, ctx, args?.model)
        const model = chooseModel(items, "video", args?.model)
        const body = { model: runtime.modelName(connection, model.id), prompt }
        if (text(args?.size)) body.size = text(args.size)
        if (args?.seconds !== undefined) {
          if (!Number.isInteger(args.seconds) || args.seconds < 1 || args.seconds > 60) {
            throw new Error("seconds must be an integer from 1 to 60")
          }
          body.seconds = args.seconds
        }
        if (imageURL || fileID) {
          body.input_reference = imageURL ? { image_url: imageURL } : { file_id: fileID }
        }

        const response = await runtime.request(connection, "/videos", {
          body,
          signal: toolSignal(ctx),
        })
        return {
          model: withoutProvider(model.id),
          ...videoResult(connection, response),
        }
      },
    },

    opencsg_video_status: {
      description:
        "Read one OpenCSG video generation job. When status is completed, content_url points at the generated video; failed and cancelled jobs include the gateway error.",
      args: {
        type: "object",
        properties: {
          video_id: { type: "string", minLength: 1 },
        },
        required: ["video_id"],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const videoID = text(args?.video_id)
        if (!videoID) throw new Error("video_id is required")
        const signal = toolSignal(ctx)
        const connection = await runtime.connection(signal)
        const response = await runtime.request(
          connection,
          `/videos/${encodeURIComponent(videoID)}`,
          { signal },
        )
        return videoResult(connection, response)
      },
    },

    opencsg_system_one: {
      description:
        "Ask a typed decision model through OpenCSG's System One /systemone endpoint. Questions may use noul, choice or score; choice questions require criteria. The response contains answers and usage.",
      args: {
        type: "object",
        properties: {
          state: {
            description: "The situation to evaluate: a string, object, array or other JSON value.",
          },
          questions: {
            type: "object",
            minProperties: 1,
            additionalProperties: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  description: "Question type, usually noul, choice or score.",
                },
                instructions: { description: "Instructions for this question. Any JSON value." },
                criteria: {
                  description: "Type-specific criteria; choice questions require this.",
                },
              },
              required: ["type"],
              additionalProperties: true,
            },
          },
          model: { type: "string", description: "Optional System One decision model ID." },
          temperature: { type: "number", minimum: 0, maximum: 2 },
        },
        required: ["state", "questions"],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const body = systemOneBody(args)
        const { connection, items } = await toolCatalog(runtime, ctx, args?.model)
        const model = chooseModel(items, "decision", args?.model)
        const payload = {
          model: runtime.modelName(connection, model.id),
          ...body,
        }
        if (args?.temperature !== undefined) {
          if (!Number.isFinite(args.temperature) || args.temperature < 0 || args.temperature > 2) {
            throw new Error("temperature must be a number from 0 to 2")
          }
          payload.temperature = args.temperature
        }
        const response = await runtime.request(connection, "/systemone", {
          body: payload,
          signal: toolSignal(ctx),
        })
        if (!isObject(response?.answers)) {
          throw new Error("OpenCSG System One response did not include answers")
        }
        return { model: withoutProvider(model.id), ...response }
      },
    },
  }
}

async function openCodeCredential(ctx) {
  const connection = await ctx.integration?.connection?.active?.(PROVIDER)
  if (!connection) throw new Error("Sign in to OpenCSG before using its tools")
  const credential = await ctx.integration.connection.resolve(connection).catch(() => undefined)
  const auth = credentialAuth(credential)
  if (!auth?.key) throw new Error("OpenCSG credentials do not contain an AI Gateway key")
  return auth
}

function magpieToolRuntime() {
  const baseURL = magpieGatewayBase()
  return {
    async connection() {
      return {
        baseURL,
        key: "",
        systemOneBase: catalogCache.endpoints?.decide,
      }
    },
    endpoints() {
      return catalogCache.endpoints ?? availableEndpoints()
    },
    async catalog(connection, signal) {
      if (catalogCache.items.length && Date.now() - catalogCache.at < 10 * 60_000) {
        return catalogCache.items
      }
      const body = await apiRequest(connection.baseURL, "", "/models", {
        signal,
        timeout: TIMEOUT_MS,
      })
      const items = (Array.isArray(body?.data) ? body.data : [])
        .filter((model) => text(model?.owned_by) === PROVIDER || text(model?.id).startsWith(`${PROVIDER}/`))
        .map(gatewayModelItem)
        .filter((model) => modelKinds(model).length)
      return items
    },
    modelName(_connection, id) {
      const value = withoutProvider(id)
      return value.startsWith(`${PROVIDER}/`) ? value : `${PROVIDER}/${value}`
    },
    request(connection, path, options) {
      return apiRequest(connection.baseURL, "", path, options)
    },
  }
}

function openCodeToolRuntime(ctx) {
  return {
    connection: () => openCodeCredential(ctx),
    endpoints(connection) {
      return availableEndpoints(connection.baseURL, connection.systemOneBase)
    },
    catalog(connection, signal) {
      return readModels(connection.baseURL, connection.key, signal)
    },
    modelName(_connection, id) {
      return withoutProvider(id)
    },
    request(connection, path, options) {
      const base = path === "/systemone" && connection.systemOneBase
        ? connection.systemOneBase
        : connection.baseURL
      return apiRequest(base, connection.key, path, options)
    },
  }
}

function openCodeTools(ctx) {
  const definitions = createToolDefinitions(openCodeToolRuntime(ctx))
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      {
        description: definition.description,
        options: { codemode: false },
        input: definition.args,
        async execute(args, toolContext) {
          const result = await definition.execute(args, toolContext)
          const output = typeof result === "string" ? result : JSON.stringify(result)
          return { content: output, output }
        },
      },
    ]),
  )
}

function signedIn(auth) {
  return auth?.type === "api" && !!text(auth.key)
}

function markSignIn(res) {
  if (res.status !== 401 && res.status !== 403) return res
  const headers = new Headers(res.headers)
  headers.set("X-Magpie-Sign-In", "expired")
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

function systemOneTarget(input, base) {
  let url
  try {
    url = new URL(input instanceof Request ? input.url : String(input))
  } catch {
    return undefined
  }
  if (!/\/systemone\/?$/i.test(url.pathname)) return undefined
  const target = new URL(`${normalizeSystemOne(base)}/systemone`)
  target.search = url.search
  return target.toString()
}

function openCodeGatewayField() {
  return {
    type: "string",
    // OpenCode overlays a key credential's form answers onto the provider
    // settings. Avoid the reserved `baseURL` key so the user's unnormalized
    // input cannot override the `/v1` endpoint selected below.
    key: "gateway",
    title: "Gateway URL",
    description: "Leave empty for the public OpenCSG AI Gateway.",
    placeholder: DEFAULT_BASE,
    format: "uri",
  }
}

function openCodeSystemOneField() {
  return {
    type: "string",
    key: "systemOneURL",
    title: "System One URL",
    description: "Optional; leave empty to use the gateway's /v1 base.",
    placeholder: DEFAULT_BASE,
    format: "uri",
  }
}

function credentialAuth(credential) {
  if (credential?.type === "oauth") {
    const baseURL = normalizeBase(credential.metadata?.baseURL)
    return {
      key: text(credential.access),
      baseURL,
      systemOneBase: normalizeSystemOne(credential.metadata?.systemOneURL, baseURL),
    }
  }
  if (credential?.type === "key") {
    // `gateway` is the current OpenCode field. `baseURL` keeps credentials
    // created by earlier versions working.
    const baseURL = normalizeBase(
      credential.configuration?.gateway ?? credential.configuration?.baseURL,
    )
    return {
      key: text(credential.key),
      baseURL,
      systemOneBase: normalizeSystemOne(
        credential.configuration?.systemOneURL,
        baseURL,
      ),
    }
  }
  return undefined
}

function openCodeModel(item, previous) {
  const model = modelOf(item, { models: previous ?? {} })
  if (!model.id) return undefined
  return {
    id: model.id,
    modelID: model.id,
    providerID: PROVIDER,
    name: model.name,
    package: OPENCODE_NPM,
    capabilities: {
      tools: model.tool_call,
      input: model.attachment ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: model.cost ? [model.cost] : [],
    status: model.status ?? "active",
    enabled: true,
    limit: {
      context: model.limit?.context ?? 0,
      output: model.limit?.output ?? 0,
    },
  }
}

function openCodeProvider(baseURL) {
  return {
    id: PROVIDER,
    integrationID: PROVIDER,
    name: "OpenCSG",
    activation: "enabled",
    package: OPENCODE_NPM,
    settings: { baseURL },
    headers: { "X-OpenCSG-Client": CLIENT_HEADER },
  }
}

function openCodeModels(items, previous, baseURL) {
  const models = new Map()
  for (const item of items) {
    if (!supportsChat(item)) continue
    const model = openCodeModel(item, previous?.get?.(item.id) ?? previous?.[item.id])
    if (!model) continue
    model.settings = { baseURL }
    models.set(model.id, model)
  }
  return models
}

function fallbackOpenCodeModels(baseURL = DEFAULT_BASE) {
  return openCodeModels(
    Object.entries(FALLBACK_MODELS).map(([id, model]) => ({ ...model, id })),
    undefined,
    baseURL,
  )
}

function withOpenCodeBaseURL(models, baseURL) {
  const result = new Map()
  for (const [id, model] of models) {
    result.set(id, {
      ...model,
      settings: {
        ...(isObject(model.settings) ? model.settings : {}),
        baseURL,
      },
    })
  }
  return result
}

function openCodeOAuth() {
  return {
    integrationID: PROVIDER,
    method: {
      id: "oauth",
      type: "oauth",
      label: "Sign in with OpenCSG",
      form: [openCodeGatewayField(), openCodeSystemOneField()],
    },
    async authorize(inputs) {
      let gateway
      let systemOne
      try {
        gateway = normalizeBase(inputs?.gateway ?? inputs?.baseURL)
        systemOne = normalizeSystemOne(inputs?.systemOneURL, gateway)
      } catch (e) {
        throw new Error(e.message)
      }

      let session
      try {
        session = await callbackServer()
      } catch (e) {
        throw new Error(e.message)
      }

      let url
      try {
        url = await authorizeURL(portalOf(gateway))
      } catch (e) {
        session.close()
        throw new Error(e.message)
      }

      const callback = (async () => {
        try {
          const result = await session.completion
          if (result.error) throw result.error
          const { key, claims } = await keyForJWT(result.jwt, gateway)
          await validateKey(gateway, key)
          return {
            type: "oauth",
            methodID: "oauth",
            access: key,
            refresh: "",
            expires: 0,
            metadata: {
              baseURL: gateway,
              systemOneURL:
                systemOne === protocolEndpoints(gateway).decide ? "" : systemOne,
              username: claims.username,
              uuid: claims.uuid,
            },
          }
        } finally {
          session.close()
        }
      })()

      return {
        mode: "auto",
        url,
        instructions:
          "Finish signing in to OpenCSG in your browser. OpenCode will fetch an AI Gateway key automatically.",
        callback,
      }
    },
    label: (credential) => text(credential.metadata?.username) || undefined,
  }
}

async function readOpenCodeCatalog(ctx, models) {
  const connection = await ctx.integration.connection.active(PROVIDER)
  const auth = connection
    ? credentialAuth(
        await ctx.integration.connection.resolve(connection).catch(() => undefined),
      )
    : undefined
  const baseURL = auth?.baseURL ?? DEFAULT_BASE
  const endpoints = availableEndpoints(baseURL, auth?.systemOneBase)
  const retained =
    models instanceof Map && models.size
      ? withOpenCodeBaseURL(models, baseURL)
      : fallbackOpenCodeModels(baseURL)
  try {
    const items = await readModels(baseURL, auth?.key ?? "")
    const live = openCodeModels(items, models, baseURL)
    return {
      baseURL,
      endpoints,
      models: live.size ? live : retained,
      sourceConnection: connection,
    }
  } catch {
    // A failed refresh cannot prove that the retained catalog belongs to the
    // active connection. Keep the provider visible, but do not bind stale
    // models to a new credential.
    return { baseURL, endpoints, models: retained }
  }
}

async function openCodeSetup(ctx) {
  let models = fallbackOpenCodeModels()
  let loaded = await readOpenCodeCatalog(ctx, models)
  models = loaded.models

  await ctx.integration.transform((editor) => {
    editor.update(PROVIDER, (integration) => {
      integration.name = "OpenCSG"
    })
    editor.method.update({
      integrationID: PROVIDER,
      method: {
        type: "key",
        label: "OpenCSG API key",
        form: [openCodeGatewayField(), openCodeSystemOneField()],
      },
    })
    editor.method.update(openCodeOAuth())
  })

  if (typeof ctx.tool?.transform === "function") {
    const tools = openCodeTools(ctx)
    await ctx.tool.transform((editor) => {
      for (const [name, tool] of Object.entries(tools)) editor.add({ name, ...tool })
    })
  }

  // Register the transform once. Credential events update the captured snapshot
  // and reload the provider registry instead of stacking duplicate transforms.
  await ctx.provider.transform((editor) => {
    editor.add({
      info: openCodeProvider(loaded.baseURL),
      models: Array.from(loaded.models.values()),
      ...(loaded.sourceConnection ? { sourceConnection: loaded.sourceConnection } : {}),
    })
  })

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "credential.switched") {
          if (event.data.integrationID !== PROVIDER) continue
        } else if (event.type !== "credential.updated") {
          continue
        }
        // A key login emits the event before its batched transform has
        // necessarily become visible. Reload first so the catalog is read with
        // the new credential.
        await ctx.provider.reload()
        const next = await readOpenCodeCatalog(ctx, models)
        models = next.models
        loaded = next
        await ctx.provider.reload()
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        console.error("[opencsg] event stream failed:", e)
      }
    }
  })()

  return () => controller.abort()
}

const OpenCodePlugin = {
  id: PLUGIN_ID,
  setup: openCodeSetup,
}

export default OpenCodePlugin

export const OpenCSGAuthPlugin = async ({ client } = {}) => {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "OpenCSG",
        npm: NPM,
        api: DEFAULT_BASE,
        models: FALLBACK_MODELS,
      }
      const provider = cfg.provider[PROVIDER]
      configureProviderEndpoints(provider)
      provider.models ??= FALLBACK_MODELS
    },

    auth: {
      provider: PROVIDER,
      methods: [
        authMethod("api", "OpenCSG API key"),
        {
          type: "oauth",
          label: "Sign in with OpenCSG",
          prompts: AUTH_PROMPTS,
          async authorize(inputs) {
            let gateway
            let systemOne
            const protocol = normalizeAccountProtocol(inputs?.protocol)
            try {
              gateway = normalizeBase(inputs?.baseURL)
              systemOne = normalizeSystemOne(inputs?.systemOneURL, gateway)
            } catch (e) {
              return { type: "failed", error: e.message }
            }

            let session
            try {
              session = await callbackServer()
            } catch (e) {
              return { type: "failed", error: e.message }
            }

            let url
            try {
              url = await authorizeURL(portalOf(gateway))
            } catch (e) {
              session.close()
              return { type: "failed", error: e.message }
            }

            return {
              url,
              instructions:
                `Finish signing in to OpenCSG in your browser. magpie will fetch an AI Gateway key automatically. ` +
                `The browser returns to ${session.callbackURL}.`,
              method: "auto",
              async callback() {
                try {
                  const result = await session.completion
                  if (result.error) throw result.error
                  const { key, claims } = await keyForJWT(result.jwt, gateway)
                  await validateKey(gateway, key)
                  return {
                    type: "success",
                    key,
                    metadata: {
                      baseURL: gateway === DEFAULT_BASE ? "" : gateway,
                      systemOneURL:
                        systemOne === protocolEndpoints(gateway).decide ? "" : systemOne,
                      ...(protocol ? { protocol } : {}),
                      username: claims.username,
                      uuid: claims.uuid,
                    },
                  }
                } catch (e) {
                  return { type: "failed", error: e.message }
                } finally {
                  session.close()
                }
              },
              close() {
                session.close()
              },
            }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (!signedIn(auth)) return {}
        const base = gatewayOf(auth)
        const systemOneBase = normalizeSystemOne(
          auth.metadata?.systemOneURL || endpointSettings.systemOneURL,
          base,
        )
        const accountProtocol = normalizeAccountProtocol(auth.metadata?.protocol)
        return {
          baseURL: base,
          apiKey: auth.key,
          headers: { "X-OpenCSG-Client": CLIENT_HEADER },
          async fetch(input, init) {
            const wanted = requestProtocol(input)
            if (accountProtocol && wanted && accountProtocol !== wanted) {
              const account = text(auth.metadata?.username) || "this OpenCSG account"
              return Response.json(
                {
                  error: {
                    type: "account_protocol_mismatch",
                    message:
                      `${account} is restricted to ${PROTOCOL_LABELS[accountProtocol]}; ` +
                      `this request is for ${PROTOCOL_LABELS[wanted]}.`,
                  },
                },
                {
                  status: 503,
                  statusText: "OpenCSG account protocol mismatch",
                  headers: { "X-OpenCSG-Account-Protocol": accountProtocol },
                },
              )
            }
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
            headers.set("Authorization", `Bearer ${auth.key}`)
            headers.set("Accept", headers.get("Accept") ?? "application/json")
            headers.delete("content-length")
            const target = systemOneTarget(input, systemOneBase)
            const request = target
              ? input instanceof Request
                ? new Request(target, input)
                : target
              : input
            const res = await fetch(request, {
              ...init,
              headers,
              signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
            })
            return markSignIn(res)
          },
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth, signal } = {}) {
        // The public model catalog is readable without a key. Use a signed-in
        // account (and its custom gateway) when one exists, but do not require
        // one just to show what OpenCSG offers.
        const key = signedIn(auth) ? auth.key : ""
        const base = signedIn(auth) ? gatewayOf(auth) : DEFAULT_BASE
        try {
          const items = await readModels(base, key, signal)
          catalogCache.base = base
          catalogCache.endpoints = availableEndpoints(
            base,
            auth?.metadata?.systemOneURL || endpointSettings.systemOneURL,
          )
          catalogCache.items = items
          catalogCache.at = Date.now()
          const live = liveModels(items, provider)
          return Object.keys(live).length ? { ...provider.models, ...live } : provider.models
        } catch (e) {
          // Keep the list magpie already had. A failed refresh must not wipe
          // the user's models or turn a passing gateway outage into an empty
          // provider.
          return provider.models
        }
      },
    },

    tool: createToolDefinitions(magpieToolRuntime()),
  }
}

// for tests
export const _internal = {
  PROVIDER,
  DEFAULT_BASE,
  ACCOUNT_PROTOCOLS,
  ALTERNATE_PROTOCOLS,
  FALLBACK_MODELS,
  DEFAULT_MAGPIE_GATEWAY,
  OpenCodePlugin,
  apiRequest,
  catalogCache,
  chooseModel,
  createToolDefinitions,
  credentialAuth,
  endpointSettings,
  modelKind,
  modelKinds,
  openCodeModel,
  openCodeModels,
  openCodeProvider,
  openCodeOAuth,
  openCodeSetup,
  openCodeTools,
  magpieGatewayBase,
  magpieToolRuntime,
  plugin: OpenCSGAuthPlugin,
  normalizeAccountProtocol,
  normalizeBase,
  requestProtocol,
  portalOf,
  parseJWTPayload,
  keyFromPayload,
  authMethod,
  SIGNIN_STATE,
  DEFAULT_SIGNIN_CALLBACK,
  signInCallbackURL,
  validateKey,
  discoverAuthorizeURL,
  fallbackAuthorizeURL,
  authorizeURL,
  callbackServer,
  keyForJWT,
  readModels,
  pricingOf,
  tasksOf,
  modelOf,
  availableEndpoints,
  normalizeSystemOne,
  protocolEndpoints,
  liveModels,
  markSignIn,
  systemOneBody,
  systemOneTarget,
  videoResult,
  withoutProvider,
}
