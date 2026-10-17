// OpenCSG AI Gateway as a magpie provider.
//
// OpenCSG's gateway is OpenAI-compatible. API keys created in the platform
// (they start with "gw-sk-") are sent as Bearer tokens; models and their
// capability metadata come from GET /v1/models. The same plugin also accepts
// a custom gateway base URL, which is useful for private CSGHub deployments.

import { randomUUID } from "node:crypto"
import { createServer } from "node:http"

const PROVIDER = "opencsg"
const DEFAULT_BASE = "https://opencsg.com/aigateway/v1"
const DEFAULT_PORTAL = "https://opencsg.com"
const DEFAULT_IAM_AUTHORIZE = "https://iam.opencsg.com/login/oauth/authorize"
const DEFAULT_IAM_CLIENT_ID = "d623c957e69976c8a7a8"
const DEFAULT_IAM_CALLBACK = "https://opencsg.com/api/v1/callback/casdoor"
const NPM = "@ai-sdk/openai-compatible"
const TIMEOUT_MS = 20_000
const OAUTH_TIMEOUT_MS = 10 * 60_000
const MAX_PAGES = 20

// A conservative fallback used before the live list can be read. The gateway
// exposes many more models; provider.models replaces this list when live data
// is available. Keep only stable, generally available IDs here.
const FALLBACK_MODELS = {
  auto: {
    name: "Auto",
    limit: { context: 200_000, output: 32_000 },
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
  },
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

function gatewayOf(auth) {
  return normalizeBase(auth?.metadata?.baseURL)
}

function portalOf(base) {
  return new URL(normalizeBase(base)).origin
}

function modelsURL(base) {
  return `${base}/models?page=1&per=100`
}

function safeJSON(value) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

async function responseError(res) {
  const body = await res.text().catch(() => "")
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

function authMethod(type, label) {
  return {
    type,
    label,
    placeholder: type === "api" ? "gw-sk-…" : "",
    prompts: [BASE_URL_PROMPT],
  }
}

async function discoverAuthorizeURL(portal, callbackURL, signal) {
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
    authorize.searchParams.set("state", callbackURL)
    return authorize.toString()
  } catch {
    return undefined
  }
}

function fallbackAuthorizeURL(callbackURL) {
  const authorize = new URL(DEFAULT_IAM_AUTHORIZE)
  authorize.searchParams.set("client_id", DEFAULT_IAM_CLIENT_ID)
  authorize.searchParams.set("response_type", "code")
  authorize.searchParams.set("redirect_uri", DEFAULT_IAM_CALLBACK)
  authorize.searchParams.set("scope", "read")
  authorize.searchParams.set("state", callbackURL)
  return authorize.toString()
}

async function authorizeURL(portal, callbackURL, signal) {
  const discovered = await discoverAuthorizeURL(portal, callbackURL, signal)
  if (discovered) return discovered
  if (portal === DEFAULT_PORTAL) return fallbackAuthorizeURL(callbackURL)
  throw new Error("Could not start OpenCSG sign-in for this gateway")
}

function callbackPage(ok) {
  const title = ok ? "OpenCSG sign-in complete" : "OpenCSG sign-in failed"
  const message = ok
    ? "You can close this window and return to magpie."
    : "Return to magpie and start sign-in again."
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`
}

function localCallback(nonce, finish, done) {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("Content-Type", "text/html; charset=utf-8")

    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.statusCode = 404
      res.end(callbackPage(false))
      return
    }
    if (url.searchParams.get("nonce") !== nonce) {
      res.statusCode = 400
      res.end(callbackPage(false))
      return
    }

    const jwt = text(url.searchParams.get("jwt_token"))
    if (!jwt) {
      res.statusCode = 400
      res.end(callbackPage(false))
      if (!done()) {
        finish({ error: new Error("OpenCSG did not return a sign-in token. Try again.") })
      }
      return
    }

    res.statusCode = 200
    res.end(callbackPage(true))
    if (!done()) finish({ jwt })
  }
}

async function callbackServer() {
  const nonce = randomUUID()
  let finish
  let done = false
  const completion = new Promise((resolve) => {
    finish = resolve
  })

  const server = createServer(localCallback(nonce, finish, () => {
    if (done) return true
    done = true
    return false
  }))

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("Could not start the local OpenCSG sign-in listener")
  }

  const callbackURL = new URL(`http://127.0.0.1:${address.port}/callback`)
  callbackURL.searchParams.set("nonce", nonce)
  const timer = setTimeout(() => {
    if (done) return
    done = true
    finish({ error: new Error("OpenCSG sign-in timed out. Try again.") })
    server.close()
  }, OAUTH_TIMEOUT_MS)
  timer.unref?.()

  return {
    callbackURL: callbackURL.toString(),
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

function supportsChat(model) {
  const tasks = tasksOf(model)
  return tasks.size === 0 || tasks.has("text-generation") || tasks.has("image-text-to-text")
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
  const images = tasks.has("image-text-to-text") || item?.metadata?.is_vision_model === true
  const toolCall = item?.support_function_call === true
  const available = item?.availability?.is_available !== false
  const previous = provider?.models?.[id] ?? {}
  const name = text(item?.name) || text(item?.metadata?.display_name) || labelOf(id)
  const context = positive(item?.context_length) ?? positive(item?.metadata?.context_length) ?? previous.limit?.context ?? 0
  const output =
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
    limit: { context, output },
    tool_call: toolCall,
    attachment: images,
    modalities: { input: images ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      temperature: true,
      reasoning: false,
      toolcall: toolCall,
      attachment: images,
      input: { text: true, image: images },
      output: { text: true },
    },
    ...(pricing ? { cost: pricing } : {}),
    ...(available ? {} : { status: "deprecated" }),
  }
  return model
}

function liveModels(items, provider) {
  const models = {}
  for (const item of items) {
    if (!supportsChat(item)) continue
    const m = modelOf(item, provider)
    if (m.id) models[m.id] = m
  }
  return models
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
    },

    auth: {
      provider: PROVIDER,
      methods: [
        authMethod("api", "OpenCSG API key"),
        {
          type: "oauth",
          label: "Sign in with OpenCSG",
          prompts: [BASE_URL_PROMPT],
          async authorize(inputs) {
            let gateway
            try {
              gateway = normalizeBase(inputs?.baseURL)
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
              url = await authorizeURL(portalOf(gateway), session.callbackURL)
            } catch (e) {
              session.close()
              return { type: "failed", error: e.message }
            }

            return {
              url,
              instructions:
                "Finish signing in to OpenCSG in your browser. magpie will fetch an AI Gateway key automatically.",
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
        return {
          baseURL: base,
          apiKey: auth.key,
          headers: { "X-OpenCSG-Client": "opencsg-magpie/0.1.0" },
          async fetch(input, init) {
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
            headers.set("Authorization", `Bearer ${auth.key}`)
            headers.set("Accept", headers.get("Accept") ?? "application/json")
            headers.delete("content-length")
            const res = await fetch(input, {
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
      async models(provider, { auth } = {}) {
        // The public model catalog is readable without a key. Use a signed-in
        // account (and its custom gateway) when one exists, but do not require
        // one just to show what OpenCSG offers.
        const key = signedIn(auth) ? auth.key : ""
        const base = signedIn(auth) ? gatewayOf(auth) : DEFAULT_BASE
        try {
          const items = await readModels(base, key)
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
  }
}

// for tests
export const _internal = {
  PROVIDER,
  DEFAULT_BASE,
  FALLBACK_MODELS,
  plugin: OpenCSGAuthPlugin,
  normalizeBase,
  portalOf,
  parseJWTPayload,
  keyFromPayload,
  authMethod,
  discoverAuthorizeURL,
  fallbackAuthorizeURL,
  authorizeURL,
  callbackServer,
  keyForJWT,
  readModels,
  pricingOf,
  tasksOf,
  modelOf,
  liveModels,
  markSignIn,
}
