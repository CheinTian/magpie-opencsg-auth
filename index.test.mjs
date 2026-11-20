import { afterEach, describe, expect, test } from "bun:test"

import OpenCodePlugin, { _internal } from "./index.mjs"
import * as MagpieModule from "./magpie.mjs"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  _internal.catalogCache.items = []
  _internal.catalogCache.base = ""
  _internal.catalogCache.endpoints = undefined
  _internal.catalogCache.at = 0
  _internal.endpointSettings.systemOneURL = ""
  _internal.usageCache.clear()
})

const modelPage = (data, extra = {}) => ({
  object: "list",
  data,
  ...extra,
})

const jwt = (claims) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`
}

describe("normalizeBase", () => {
  test("uses the public gateway when omitted", () => {
    expect(_internal.normalizeBase("")).toBe("https://opencsg.com/aigateway/v1")
    expect(_internal.normalizeBase(undefined)).toBe("https://opencsg.com/aigateway/v1")
  })

  test("normalizes gateway URLs", () => {
    expect(_internal.normalizeBase("https://opencsg.com/aigateway")).toBe(
      "https://opencsg.com/aigateway/v1",
    )
    expect(_internal.normalizeBase("https://example.com/v1/")).toBe("https://example.com/v1")
    expect(_internal.normalizeBase("https://example.com/aigateway/v1?x=1#top")).toBe(
      "https://example.com/aigateway/v1",
    )
    expect(_internal.normalizeBase("http://localhost:8080")).toBe("http://localhost:8080/v1")
  })

  test("rejects non-http and relative URLs", () => {
    expect(() => _internal.normalizeBase("ftp://example.com")).toThrow("http or https")
    expect(() => _internal.normalizeBase("example.com/v1")).toThrow("absolute http(s) URL")
  })
})

describe("account protocol", () => {
  test("normalizes only the protocols OpenCSG exposes", () => {
    expect(_internal.normalizeAccountProtocol(" Anthropic ")).toBe("anthropic")
    expect(_internal.normalizeAccountProtocol("chat")).toBe("chat")
    expect(_internal.normalizeAccountProtocol("responses")).toBe("responses")
    expect(_internal.normalizeAccountProtocol("")).toBe("")
    expect(_internal.normalizeAccountProtocol("gemini")).toBe("")
  })

  test("reads the protocol from native request paths", () => {
    expect(_internal.requestProtocol("https://example.com/v1/chat/completions")).toBe("chat")
    expect(_internal.requestProtocol("https://example.com/v1/messages")).toBe("anthropic")
    expect(_internal.requestProtocol("https://example.com/v1/messages/count_tokens")).toBe("anthropic")
    expect(_internal.requestProtocol("https://example.com/v1/responses")).toBe("responses")
    expect(_internal.requestProtocol("https://example.com/v1/systemone")).toBe("")
  })
})

describe("OAuth", () => {
  test("normalizes the portal from gateway URLs", () => {
    expect(_internal.portalOf("https://opencsg.com/aigateway/v1")).toBe("https://opencsg.com")
    expect(_internal.portalOf("https://example.com/aigateway")).toBe("https://example.com")
  })

  test("reads the CSGHub user identity from a JWT", () => {
    expect(_internal.parseJWTPayload(jwt({ current_user: "alice", uuid: "user-uuid" }))).toEqual({
      username: "alice",
      uuid: "user-uuid",
    })
    expect(() => _internal.parseJWTPayload("not-a-jwt")).toThrow("invalid sign-in token")
    expect(() => _internal.parseJWTPayload(jwt({ current_user: "alice" }))).toThrow(
      "invalid sign-in token",
    )
  })

  test("extracts keys from nested CSGHub response shapes", () => {
    expect(_internal.keyFromPayload("gk-test")).toBe("gk-test")
    expect(_internal.keyFromPayload({ data: { token: "gk-test" } })).toBe("gk-test")
    expect(_internal.keyFromPayload({ data: { user_name: "alice" } })).toBe("")
  })

  test("asks the user service for the lite sign-in target", async () => {
    let request
    globalThis.fetch = async (input, init) => {
      request = { url: String(input), init }
      return new Response(null, {
        status: 303,
        headers: { location: "https://iam.opencsg.com/login/oauth/authorize?client_id=client&state=casdoor" },
      })
    }

    const url = await _internal.discoverAuthorizeURL("https://opencsg.com")
    const parsed = new URL(url)

    expect(request.url).toBe("https://opencsg.com/login")
    expect(request.init.redirect).toBe("manual")
    expect(parsed.origin).toBe("https://iam.opencsg.com")
    expect(parsed.searchParams.get("client_id")).toBe("client")
    // Anything but the registered routing states lands on the portal's
    // server-error page (error_code=500); `lite` is the loopback target.
    expect(parsed.searchParams.get("state")).toBe("lite")
  })

  test("falls back to the public IAM app only for opencsg.com", async () => {
    globalThis.fetch = async () => new Response("down", { status: 503 })

    const url = await _internal.authorizeURL("https://opencsg.com")
    const parsed = new URL(url)
    expect(parsed.origin).toBe("https://iam.opencsg.com")
    expect(parsed.searchParams.get("client_id")).toBe("d623c957e69976c8a7a8")
    expect(parsed.searchParams.get("state")).toBe("lite")

    await expect(_internal.authorizeURL("https://private.example")).rejects.toThrow(
      "Could not start OpenCSG sign-in",
    )
  })

  test("listens on the lite callback the platform already trusts", async () => {
    const session = await _internal.callbackServer()
    const token = jwt({ current_user: "alice", uuid: "user-uuid" })

    expect(session.callbackURL).toBe("http://127.0.0.1:11437/api/cloud/auth/callback")

    const other = await fetch("http://127.0.0.1:11437/somewhere-else")
    expect(other.status).toBe(404)

    const missing = await fetch(session.callbackURL)
    expect(missing.status).toBe(400)
    await expect(session.completion).resolves.toEqual({
      error: expect.objectContaining({ message: expect.stringContaining("did not return a sign-in token") }),
    })
    session.close()

    const second = await _internal.callbackServer()
    const good = await fetch(`${second.callbackURL}?token=csghub-token&jwt=${token}`)
    expect(good.status).toBe(200)
    await expect(second.completion).resolves.toEqual({ jwt: token })
    second.close()
  })

  test("exchanges a JWT for a builtin Gateway key", async () => {
    const token = jwt({ current_user: "alice", uuid: "user-uuid" })
    const calls = []
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) })
      return Response.json({ data: { token: "gk-test" } })
    }

    const result = await _internal.keyForJWT(token, "https://opencsg.com/aigateway/v1")

    expect(result).toEqual({
      key: "gk-test",
      claims: { username: "alice", uuid: "user-uuid" },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://opencsg.com/api/v1/namespaces/user-uuid/apikeys/builtin")
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${token}`)
  })

  test("falls back to tokens/first when builtin keys fail", async () => {
    const token = jwt({ current_user: "alice", uuid: "user-uuid" })
    const calls = []
    globalThis.fetch = async (input) => {
      calls.push(String(input))
      if (calls.length === 1) return Response.json({ msg: "not available" }, { status: 404 })
      return Response.json({ data: "gk-fallback" })
    }

    const result = await _internal.keyForJWT(token, "https://opencsg.com/aigateway/v1")

    expect(result.key).toBe("gk-fallback")
    expect(calls[1]).toBe(
      "https://opencsg.com/api/v1/user/alice/tokens/first?app=aigateway&token_name=magpie",
    )
  })
})

describe("readModels", () => {
  test("follows cursors and sends the account key", async () => {
    const calls = []
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) })
      const url = new URL(input)
      if (!url.searchParams.has("after")) {
        return Response.json(
          modelPage([{ id: "one" }, { id: "two" }], {
            has_more: true,
            last_id: "two",
          }),
        )
      }
      expect(url.searchParams.get("after")).toBe("two")
      return Response.json(
        modelPage([{ id: "two" }, { id: "three" }], {
          has_more: false,
        }),
      )
    }

    const items = await _internal.readModels("https://gateway.example/v1", "gw-sk-test")

    expect(items.map((item) => item.id)).toEqual(["one", "two", "three"])
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe("https://gateway.example/v1/models?page=1&per=100")
    expect(calls[0].headers.get("authorization")).toBe("Bearer gw-sk-test")
    expect(calls[1].url).toContain("after=two")
  })

  test("does not send authorization without a key", async () => {
    let headers
    globalThis.fetch = async (_input, init) => {
      headers = new Headers(init.headers)
      return Response.json(modelPage([]))
    }

    await _internal.readModels("https://gateway.example/v1", "")

    expect(headers.get("authorization")).toBeNull()
  })

  test("throws the gateway error instead of returning partial data", async () => {
    globalThis.fetch = async () =>
      Response.json({ error: { message: "invalid key" } }, { status: 401 })

    await expect(_internal.readModels("https://gateway.example/v1", "bad")).rejects.toThrow(
      "OpenCSG answered 401: invalid key",
    )
  })
})

describe("account usage", () => {
  const gateway = "https://gateway.example/aigateway/v1"
  const portal = "https://gateway.example"
  const auth = (metadata = {}) => async () => ({ type: "api", key: "gk-test", metadata })

  const account = {
    user_uuid: "user-1",
    user_name: "alice",
    ns_uuid: "user-1",
  }
  const balance = (cents, bonus = 0, cash = cents) => ({
    msg: "OK",
    data: { balance: cents, composition: { bonus, cash }, low_balance_warn: 10000 },
  })

  test("renders 分 as 元, as the portal does", () => {
    expect(_internal.moneyOfCents(550984.7062496282)).toBe("¥5,509.85")
    expect(_internal.moneyOfCents(-41141.09013933388)).toBe("-¥411.41")
    expect(_internal.moneyOfCents(0)).toBe("¥0.00")
    expect(_internal.moneyOfCents(123456789)).toBe("¥1,234,567.89")
    expect(_internal.moneyOfCents(undefined)).toBe("")
  })

  test("counts plan quotas in the unit the task is metered in", () => {
    expect(_internal.quotaUnitOf("text-generation")).toBe("tokens")
    expect(_internal.quotaUnitOf("text-ranking")).toBe("tokens")
    expect(_internal.quotaUnitOf("text-to-image")).toBe("requests")
    expect(_internal.quotaUnitOf("")).toBe("")
    expect(_internal.quotaUnitOf("text-generation,text-to-image")).toBe("")
  })

  test("maps a token plan to per-model windows that renew with the period", () => {
    const plan = _internal.planOf({
      status: "active",
      end_at: 0,
      latest_plan_version: { plan_name: "Pro", billing_period: 1, period_unit: "month" },
      latest_period: {
        start_at: 1_767_225_600,
        end_at: 1_769_904_000,
        models_usage: [
          { model_id: "Qwen/Qwen3-32B", task_type: "text-generation", quota_tokens: 2_000_000, used_tokens: 500_000 },
          { model_id: "black-forest-labs/FLUX.1", task_type: "text-to-image", quota_request_count: 100, used_request_count: 25 },
          { model_id: "skip/empty", task_type: "text-generation", quota_tokens: 0, used_tokens: 0 },
        ],
      },
    })

    expect(plan.plan).toBe("Pro")
    expect(plan.renew).toBe("auto")
    expect(plan.until).toBe("2026-02-01T00:00:00.000Z")
    expect(plan.windows).toEqual([
      {
        name: "Qwen/Qwen3-32B",
        models: ["Qwen/Qwen3-32B"],
        amount: 500_000,
        limit: 2_000_000,
        unit: "tokens",
        resetsAt: "2026-02-01T00:00:00.000Z",
      },
      {
        name: "black-forest-labs/FLUX.1",
        models: ["black-forest-labs/FLUX.1"],
        amount: 25,
        limit: 100,
        unit: "requests",
        resetsAt: "2026-02-01T00:00:00.000Z",
      },
    ])
  })

  test("reads the balance and plan behind a Gateway key", async () => {
    const calls = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(input)
      calls.push({ path: url.pathname, headers: new Headers(init.headers) })
      if (url.pathname === "/api/v1/token/gk-test") return Response.json({ msg: "OK", data: account })
      if (url.pathname === "/api/v1/accounting/credit/user-1/balance")
        return Response.json(balance(550984.7062496282, 592125.7963889621, -41141.09013933388))
      if (url.pathname === "/api/v1/accounting/token-plans/user-1/get")
        return Response.json({
          msg: "OK",
          data: {
            status: "active",
            end_at: 0,
            latest_plan_version: { plan_name: "Pro" },
            latest_period: {
              end_at: 1_769_904_000,
              models_usage: [
                { model_id: "Qwen/Qwen3-32B", task_type: "text-generation", quota_tokens: 1000, used_tokens: 250 },
              ],
            },
          },
        })
      return new Response("not found", { status: 404 })
    }

    const usage = await _internal.accountUsage(auth({ baseURL: gateway }))

    expect(usage.user).toBe("alice")
    expect(usage.balance).toBe("¥5,509.85")
    expect(usage.plan).toBe("Pro")
    expect(usage.renew).toBe("auto")
    expect(usage.windows).toEqual([
      {
        name: "Qwen/Qwen3-32B",
        models: ["Qwen/Qwen3-32B"],
        amount: 250,
        limit: 1000,
        unit: "tokens",
        resetsAt: "2026-02-01T00:00:00.000Z",
      },
      { name: "Credit", display: "Cash -¥411.41 · Bonus ¥5,921.26", aside: true },
    ])
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/token/gk-test",
      "/api/v1/accounting/credit/user-1/balance",
      "/api/v1/accounting/token-plans/user-1/get",
    ])
    for (const call of calls) expect(call.headers.get("authorization")).toBe("Bearer gk-test")
  })

  test("keeps a private deployment without accounting from failing", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(input)
      if (url.pathname === "/api/v1/token/gk-test") return Response.json({ msg: "OK", data: account })
      return new Response("not found", { status: 404 })
    }

    expect(await _internal.accountUsage(auth({ baseURL: gateway }))).toEqual({ user: "alice" })
  })

  test("answers no plan without a namespace and no balance without a user", async () => {
    globalThis.fetch = async () => new Response("not found", { status: 404 })

    expect(await _internal.accountUsage(auth({ baseURL: gateway }))).toEqual({})
  })

  test("reports a real accounting failure instead of hiding it", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(input)
      if (url.pathname === "/api/v1/token/gk-test") return Response.json({ msg: "OK", data: account })
      return Response.json({ msg: "accounting is down" }, { status: 500 })
    }

    await expect(_internal.accountUsage(auth({ baseURL: gateway }))).rejects.toThrow(
      "OpenCSG answered 500: accounting is down",
    )
  })

  test("caches a read for a minute", async () => {
    let calls = 0
    globalThis.fetch = async (input) => {
      calls++
      const url = new URL(input)
      if (url.pathname === "/api/v1/token/gk-test") return Response.json({ msg: "OK", data: account })
      if (url.pathname.endsWith("/balance")) return Response.json(balance(100))
      return new Response("not found", { status: 404 })
    }

    const first = await _internal.accountUsage(auth({ baseURL: gateway }))
    const second = await _internal.accountUsage(auth({ baseURL: gateway }))

    expect(calls).toBe(3)
    expect(second).toBe(first)
  })

  test("is wired into the plugin as magpie's usage hook", async () => {
    const plugin = await _internal.plugin({})
    expect(typeof plugin.auth.usage).toBe("function")
    globalThis.fetch = async () => new Response("not found", { status: 404 })
    expect(await plugin.auth.usage(async () => ({ type: "api", key: "gk-test", metadata: {} }))).toEqual({})
  })
})

describe("model metadata", () => {
  test("normalizes task lists and comma-separated tasks", () => {
    const tasks = _internal.tasksOf({
      task: "text-generation, image-text-to-text",
      metadata: { tasks: ["text-generation", "text-generation"] },
    })

    expect([...tasks]).toEqual(["text-generation", "image-text-to-text"])
  })

  test("maps chat, image, video and decision models without mixing chat capabilities", () => {
    const provider = { models: {} }
    const models = _internal.liveModels(
      [
        { id: "chat", task: "text-generation", support_function_call: true },
        { id: "vision", task: "image-text-to-text" },
        { id: "image", task: "text-to-image" },
        { id: "video", task: "text-to-video" },
        { id: "decision", task: "typed-decisions" },
        { id: "embed", task: "text-embedding" },
        { id: "rerank", metadata: { tasks: ["rerank"] } },
      ],
      provider,
    )

    expect(Object.keys(models)).toEqual(["chat", "vision", "image", "video", "decision"])
    expect(models.chat.tool_call).toBe(true)
    expect(models.chat.capabilities.toolcall).toBe(true)
    expect(models.chat.attachment).toBe(false)
    expect(models.vision.attachment).toBe(true)
    expect(models.vision.modalities.input).toEqual(["text", "image"])
    expect(models.chat.api).toEqual({
      id: "chat",
      npm: "@ai-sdk/openai-compatible",
    })
    expect(models.chat.also).toEqual(_internal.ALTERNATE_PROTOCOLS)
    expect(models.image.also).toBeUndefined()
    expect(models.video.also).toBeUndefined()
    expect(models.decision.also).toBeUndefined()
    expect(models.image).toMatchObject({
      kind: "image",
      tool_call: false,
      modalities: { input: ["text"], output: ["image"] },
      capabilities: { output: { text: false, image: true, video: false } },
    })
    expect(models.video).toMatchObject({
      kind: "video",
      modalities: { input: ["text"], output: ["video"] },
      capabilities: { output: { text: false, image: false, video: true } },
    })
    expect(models.decision).toMatchObject({
      kind: "decision",
      decides: true,
      tool_call: false,
    })
  })

  test("chooseModel discovers media and decision models dynamically", () => {
    const items = [
      { id: "chat", task: "text-generation" },
      { id: "image-a", task: "text-to-image" },
      { id: "video-a", task: "image-to-video", availability: { is_available: false } },
      { id: "video-b", task: "text-to-video" },
      { id: "decision-a", task: "typed-decisions" },
    ]

    expect(_internal.chooseModel(items, "image").id).toBe("image-a")
    expect(_internal.chooseModel(items, "video").id).toBe("video-b")
    expect(_internal.chooseModel(items, "decision").id).toBe("decision-a")
    expect(_internal.chooseModel(items, "image", "opencsg/image-a").id).toBe("image-a")
    expect(() => _internal.chooseModel(items, "video", "image-a")).toThrow("not a video model")
    expect(() => _internal.chooseModel(items, "video", "video-a")).toThrow("currently unavailable")
  })

  test("uses an explicit vision flag and preserves context limits", () => {
    const provider = {
      models: {
        vision: { limit: { context: 128_000, output: 8_000 } },
      },
    }
    const model = _internal.modelOf(
      {
        id: "vision",
        metadata: { is_vision_model: true },
        context_length: 256_000,
      },
      provider,
    )

    expect(model.limit).toEqual({ context: 256_000, output: 8_000 })
    expect(model.attachment).toBe(true)
    expect(model.capabilities.input.image).toBe(true)
  })

  test("marks unavailable models as deprecated", () => {
    const model = _internal.modelOf(
      { id: "old", availability: { is_available: false } },
      { models: {} },
    )

    expect(model.status).toBe("deprecated")
  })

  test("converts CNY prices to USD estimates", () => {
    const pricing = _internal.pricingOf({
      metadata: {
        pricing: {
          input_token_price: {
            currency: "￥",
            price_per_million: 7.2,
            cached_price_per_million: 3.6,
          },
          output_token_price: { currency: "￥", price_per_million: 14.4 },
        },
      },
    })

    expect(pricing).toEqual({
      input: 1,
      output: 2,
      cache: { read: 0.5, write: 0 },
    })
  })

  test("does not estimate prices without token prices", () => {
    expect(_internal.pricingOf({ metadata: { pricing: {} } })).toBeUndefined()
  })
})

describe("media and System One tools", () => {
  const catalog = [
    { id: "chat", task: "text-generation" },
    { id: "image-a", task: "text-to-image" },
    { id: "video-a", task: "image-to-video" },
    { id: "decision-a", task: "typed-decisions" },
  ]

  const runtime = (responses) => {
    const calls = []
    return {
      calls,
      connection: async () => ({ baseURL: "https://gateway.example/v1", key: "gw-sk-test" }),
      catalog: async () => catalog,
      modelName: (_connection, id) => `opencsg/${_internal.withoutProvider(id)}`,
      async request(_connection, path, options) {
        calls.push({ path, options })
        const response = responses[path]
        if (response instanceof Error) throw response
        return response
      },
    }
  }

  test("lists models by capability with SDK-facing model IDs", async () => {
    const tools = _internal.createToolDefinitions(runtime({}))
    const result = await tools.opencsg_models.execute({ kind: "video" }, {})

    expect(result.models).toEqual([
      {
        id: "video-a",
        name: "video-a",
        kinds: ["video"],
        tasks: ["image-to-video"],
        available: true,
      },
    ])
    expect(result.endpoints).toEqual({
      chat: "https://gateway.example/v1",
      anthropic: "https://gateway.example",
      responses: "https://gateway.example/v1",
      decide: "https://gateway.example/v1",
    })
    expect(result.groups.video).toEqual(["video-a"])
  })

  test("magpie tools route through the local gateway with provider-prefixed models", async () => {
    _internal.catalogCache.items = catalog
    _internal.catalogCache.base = "https://opencsg.com/aigateway/v1"
    _internal.catalogCache.at = Date.now()
    let request
    globalThis.fetch = async (input, init) => {
      request = { url: String(input), init, headers: new Headers(init?.headers) }
      return Response.json({ data: [{ url: "https://cdn.example/local.png" }] })
    }

    const tools = _internal.createToolDefinitions(_internal.magpieToolRuntime())
    const result = await tools.opencsg_generate_image.execute({ prompt: "local route" }, {})

    expect(request.url).toBe("http://127.0.0.1:3425/v1/images/generations")
    expect(request.headers.get("authorization")).toBeNull()
    expect(JSON.parse(request.init.body).model).toBe("opencsg/image-a")
    expect(result.urls).toEqual(["https://cdn.example/local.png"])
  })

  test("follows magpie's configured gateway address", () => {
    const previous = process.env.MAGPIE_ADDR
    try {
      process.env.MAGPIE_ADDR = "0.0.0.0:4999"
      expect(_internal.magpieGatewayBase()).toBe("http://0.0.0.0:4999/v1")
    } finally {
      if (previous === undefined) delete process.env.MAGPIE_ADDR
      else process.env.MAGPIE_ADDR = previous
    }
  })

  test("generates images with dynamic model selection", async () => {
    const transport = runtime({
      "/images/generations": {
        created: 1,
        data: [{ url: "https://cdn.example/image.png" }],
      },
    })
    const tools = _internal.createToolDefinitions(transport)
    const result = await tools.opencsg_generate_image.execute(
      { prompt: "a red fox", n: 2, size: "1024x1024" },
      {},
    )

    expect(transport.calls[0]).toMatchObject({
      path: "/images/generations",
      options: {
        body: {
          model: "opencsg/image-a",
          prompt: "a red fox",
          n: 2,
          size: "1024x1024",
          response_format: "url",
        },
      },
    })
    expect(result).toMatchObject({
      model: "image-a",
      prompt: "a red fox",
      urls: ["https://cdn.example/image.png"],
    })
  })

  test("creates and reads asynchronous video jobs", async () => {
    const transport = runtime({
      "/videos": {
        id: "video_job_1",
        object: "video",
        status: "queued",
        model: "image-to-video-a",
      },
      "/videos/video_job_1": {
        id: "video_job_1",
        status: "completed",
        model: "image-to-video-a",
      },
    })
    const tools = _internal.createToolDefinitions(transport)
    const created = await tools.opencsg_generate_video.execute(
      { prompt: "waves", image_url: "https://example.com/start.png", seconds: 5 },
      {},
    )

    expect(transport.calls[0]).toMatchObject({
      path: "/videos",
      options: {
        body: {
          model: "opencsg/video-a",
          prompt: "waves",
          seconds: 5,
          input_reference: { image_url: "https://example.com/start.png" },
        },
      },
    })
    expect(created).toMatchObject({
      id: "video_job_1",
      status_url: "https://gateway.example/v1/videos/video_job_1",
    })
    expect(created.content_url).toBeUndefined()

    const completed = await tools.opencsg_video_status.execute(
      { video_id: "video_job_1" },
      {},
    )
    expect(completed).toMatchObject({
      id: "video_job_1",
      status: "completed",
      content_url: "https://gateway.example/v1/videos/video_job_1/content",
    })
  })

  test("sends structured System One state and typed questions", async () => {
    const transport = runtime({
      "/systemone": {
        id: "decision_1",
        answers: { refund: { type: "noul", noul: 0.97 } },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    })
    const tools = _internal.createToolDefinitions(transport)
    const result = await tools.opencsg_system_one.execute(
      {
        model: "decision-a",
        state: { ticket: "charged twice", plan: "pro" },
        questions: {
          refund: { type: "noul", instructions: "Is the customer asking for money back?" },
          intent: { type: "choice", instructions: "What do they want?", criteria: ["refund", "help"] },
        },
        temperature: 0.2,
      },
      {},
    )

    expect(transport.calls[0]).toMatchObject({
      path: "/systemone",
      options: {
        body: {
          model: "opencsg/decision-a",
          state: { ticket: "charged twice", plan: "pro" },
          temperature: 0.2,
        },
      },
    })
    expect(result.answers.refund.noul).toBe(0.97)
    expect(() => _internal.systemOneBody({ state: "x", questions: {} })).toThrow(
      "non-empty object",
    )
    expect(() =>
      _internal.systemOneBody({ state: "x", questions: { intent: { type: "choice" } } }),
    ).toThrow("criteria is required")
  })
})

describe("markSignIn", () => {
  test("marks 401 and 403 responses as expired", async () => {
    for (const status of [401, 403]) {
      const res = _internal.markSignIn(new Response("denied", { status }))
      expect(res.status).toBe(status)
      expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
      expect(await res.text()).toBe("denied")
    }
  })

  test("leaves other responses unchanged", () => {
    const original = new Response("ok", { status: 200, headers: { "x-test": "yes" } })
    const res = _internal.markSignIn(original)

    expect(res).toBe(original)
    expect(res.headers.get("x-magpie-sign-in")).toBeNull()
  })
})

describe("plugin hooks", () => {
  const load = async (auth) => {
    const hooks = await _internal.plugin({
      client: { auth: { set: async () => {} } },
    })
    hooks.auth.loader = ((loader) => async () => loader(async () => auth))(hooks.auth.loader)
    return hooks
  }

  test("config declares the public gateway and a fallback model", async () => {
    const hooks = await load(undefined)
    const cfg = { provider: {} }

    await hooks.config(cfg)

    expect(cfg.provider.opencsg).toMatchObject({
      name: "OpenCSG",
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencsg.com/aigateway/v1",
      chat: "https://opencsg.com/aigateway/v1",
      anthropic: "https://opencsg.com/aigateway",
      responses: "https://opencsg.com/aigateway/v1",
      decide: true,
      decideURL: "https://opencsg.com/aigateway/v1",
      baseAPI: "chat",
    })
    expect(Object.keys(cfg.provider.opencsg.models)).toEqual(["auto"])
    expect(Object.keys(hooks.tool)).toEqual([
      "opencsg_models",
      "opencsg_generate_image",
      "opencsg_generate_video",
      "opencsg_video_status",
      "opencsg_system_one",
    ])
    for (const tool of Object.values(hooks.tool)) {
      expect(tool.args.type).toBe("object")
      expect(typeof tool.execute).toBe("function")
    }
  })

  test("keeps custom protocol endpoints and migrates the old decide flag", async () => {
    const hooks = await load(undefined)
    const cfg = {
      provider: {
        opencsg: {
          chat: "https://private.example/aigateway/v1",
          anthropic: "https://anthropic.example",
          responses: "",
          decide: true,
          baseAPI: "anthropic",
        },
      },
    }

    await hooks.config(cfg)

    expect(cfg.provider.opencsg).toMatchObject({
      api: "https://private.example/aigateway/v1",
      chat: "https://private.example/aigateway/v1",
      anthropic: "https://anthropic.example",
      responses: "",
      decide: true,
      decideURL: "https://private.example/aigateway/v1",
      baseAPI: "anthropic",
    })
    expect(_internal.endpointSettings.systemOneURL).toBe("")
  })

  test("keeps an explicitly configured System One endpoint", async () => {
    const hooks = await load(undefined)
    const cfg = {
      provider: {
        opencsg: {
          chat: "https://private.example/aigateway/v1",
          decide: true,
          decideURL: "https://system.example",
        },
      },
    }

    await hooks.config(cfg)

    expect(cfg.provider.opencsg.decideURL).toBe("https://system.example/v1")
    expect(_internal.endpointSettings.systemOneURL).toBe("https://system.example/v1")
  })

  test("derives protocol endpoints from custom gateway forms", () => {
    expect(_internal.protocolEndpoints("https://opencsg-stg.com/aigateway")).toEqual({
      chat: "https://opencsg-stg.com/aigateway/v1",
      anthropic: "https://opencsg-stg.com/aigateway",
      responses: "https://opencsg-stg.com/aigateway/v1",
      decide: "https://opencsg-stg.com/aigateway/v1",
    })
  })

  test("normalizes a System One base or full endpoint", () => {
    expect(
      _internal.normalizeSystemOne("https://system.example/aigateway/systemone"),
    ).toBe("https://system.example/aigateway/v1")
    expect(_internal.normalizeSystemOne("https://system.example/v1", _internal.DEFAULT_BASE)).toBe(
      "https://system.example/v1",
    )
  })

  test("models reads the public catalog without an account", async () => {
    const hooks = await load(undefined)
    let authorization
    globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init.headers).get("authorization")
      return Response.json(
        modelPage([
          { id: "public-chat", task: "text-generation" },
          { id: "public-embed", task: "text-embedding" },
        ]),
      )
    }

    const models = await hooks.provider.models({ models: { auto: { name: "Auto" } } }, {})

    expect(authorization).toBeNull()
    expect(Object.keys(models)).toEqual(["auto", "public-chat"])
  })

  test("offers both API key and automatic browser sign-in", async () => {
    const hooks = await load(undefined)
    const methods = hooks.auth.methods

    expect(methods.map((method) => method.type)).toEqual(["api", "oauth"])
    expect(methods[0]).toMatchObject({
      label: "OpenCSG API key",
      placeholder: "gw-sk-…",
    })
    expect(methods[0].authorize).toBeUndefined()
    expect(methods[0].prompts.map((prompt) => prompt.key)).toEqual([
      "baseURL",
      "systemOneURL",
      "protocol",
    ])
    expect(methods[0].prompts[2]).toMatchObject({
      type: "select",
      options: [
        { label: "Any protocol", value: "" },
        { label: "Anthropic Messages", value: "anthropic" },
        { label: "Chat Completions", value: "chat" },
        { label: "OpenAI Responses", value: "responses" },
      ],
    })
    expect(methods[1].prompts[0].key).toBe("baseURL")
    expect(methods[1].prompts[2].key).toBe("protocol")

    const localFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      if (String(input) === "https://opencsg.com/login") {
        return new Response(null, {
          status: 303,
          headers: {
            location: "https://iam.opencsg.com/login/oauth/authorize?client_id=client",
          },
        })
      }
      if (String(input).startsWith("http://127.0.0.1:")) {
        return localFetch(input)
      }
      throw new Error(`unexpected request ${input}`)
    }

    const authorization = await methods[1].authorize({ baseURL: "" })
    expect(authorization.method).toBe("auto")
    expect(new URL(authorization.url).searchParams.get("state")).toBe("lite")
    expect(authorization.instructions).toContain(
      "http://127.0.0.1:11437/api/cloud/auth/callback",
    )
    await fetch(_internal.DEFAULT_SIGNIN_CALLBACK)
    const failed = await authorization.callback()
    expect(failed.type).toBe("failed")
    expect(failed.error).toContain("did not return a sign-in token")
    authorization.close()
  })

  test("models uses account auth and preserves the old list on failure", async () => {
    const auth = {
      type: "api",
      key: "gw-sk-test",
      metadata: { baseURL: "https://private.example/aigateway" },
    }
    const hooks = await load(auth)
    const previous = { existing: { name: "Existing" } }
    let request
    globalThis.fetch = async (input, init) => {
      request = { url: String(input), headers: new Headers(init.headers) }
      return new Response("down", { status: 503, statusText: "Unavailable" })
    }

    const models = await hooks.provider.models({ models: previous }, { auth })

    expect(request.url).toBe("https://private.example/aigateway/v1/models?page=1&per=100")
    expect(request.headers.get("authorization")).toBe("Bearer gw-sk-test")
    expect(models).toBe(previous)
  })

  test("loader adds auth headers, forwards aborts and marks expired responses", async () => {
    const auth = {
      type: "api",
      key: "gw-sk-test",
      metadata: {
        baseURL: "https://private.example/v1",
        systemOneURL: "https://system.example",
      },
    }
    const hooks = await load(auth)
    const loader = await hooks.auth.loader(async () => auth)
    const signal = new AbortController().signal
    const requests = []
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init })
      return new Response("nope", { status: 401 })
    }

    const res = await loader.fetch("https://private.example/v1/chat/completions", {
      method: "POST",
      headers: {
        ...loader.headers,
        "content-type": "application/json",
        "content-length": "2",
      },
      body: "{}",
      signal,
    })

    expect(requests[0].input).toBe("https://private.example/v1/chat/completions")
    expect(requests[0].init.headers.get("authorization")).toBe("Bearer gw-sk-test")
    expect(requests[0].init.headers.get("x-opencsg-client")).toBe("opencsg-magpie/0.2.0")
    expect(requests[0].init.headers.get("content-length")).toBeNull()
    expect(requests[0].init.signal).toBe(signal)
    expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
    expect(loader.baseURL).toBe("https://private.example/v1")

    await loader.fetch("https://private.example/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(requests[1].input).toBe("https://system.example/v1/systemone")
  })

  test("loader enforces the protocol selected for an account", async () => {
    const auth = {
      type: "api",
      key: "gw-sk-test",
      metadata: {
        baseURL: "https://private.example/v1",
        protocol: "anthropic",
        username: "alice",
      },
    }
    const hooks = await load(auth)
    const loader = await hooks.auth.loader(async () => auth)
    const requests = []
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init })
      return new Response("ok")
    }

    const blocked = await loader.fetch("https://private.example/v1/chat/completions", {
      method: "POST",
      body: "{}",
    })
    expect(blocked.status).toBe(503)
    expect(blocked.headers.get("x-opencsg-account-protocol")).toBe("anthropic")
    expect(await blocked.json()).toEqual({
      error: {
        type: "account_protocol_mismatch",
        message:
          "alice is restricted to Anthropic Messages; this request is for Chat Completions.",
      },
    })
    expect(requests).toHaveLength(0)

    const allowed = await loader.fetch("https://private.example/v1/messages", {
      method: "POST",
      body: "{}",
    })
    expect(allowed.status).toBe(200)
    expect(requests).toHaveLength(1)
  })

  test("derives System One from a custom account gateway when it is not configured", async () => {
    const auth = {
      type: "api",
      key: "gw-sk-test",
      metadata: { baseURL: "https://private.example/aigateway/v1" },
    }
    const hooks = await load(auth)
    const loader = await hooks.auth.loader(async () => auth)
    const requests = []
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init })
      return new Response("ok")
    }

    await loader.fetch("https://private.example/aigateway/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })

    expect(requests[0].input).toBe("https://private.example/aigateway/v1/systemone")
  })

  test("loader stays empty when no account is signed in", async () => {
    const hooks = await load(undefined)
    const loader = await hooks.auth.loader(async () => undefined)

    expect(loader).toEqual({})
  })
})

describe("OpenCode v2 plugin", () => {
  const context = ({ connection, credential } = {}) => {
    const state = {
      integrations: new Map(),
      methods: [],
      providers: new Map(),
      tools: new Map(),
      transforms: 0,
      reloads: 0,
    }
    return {
      state,
      ctx: {
        integration: {
          connection: {
            active: async () => connection,
            resolve: async () => credential,
          },
          transform: async (callback) => {
            callback({
              update: (id, update) => {
                const integration = state.integrations.get(id) ?? { id, name: id }
                update(integration)
                state.integrations.set(id, integration)
              },
              method: {
                update: ({ method }) => state.methods.push(method),
              },
            })
          },
        },
        provider: {
          transform: async (callback) => {
            state.transforms += 1
            callback({
              add: ({ info, models, sourceConnection }) =>
                state.providers.set(info.id, { info, models, sourceConnection }),
            })
          },
          reload: async () => {
            state.reloads += 1
          },
        },
        tool: {
          transform: async (callback) => {
            callback({
              add: (tool) => state.tools.set(tool.name, tool),
            })
          },
        },
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              await new Promise(() => {})
            },
          }),
        },
      },
    }
  }

  test("exports the OpenCode v2 definition", () => {
    expect(OpenCodePlugin.id).toBe("magpie-opencsg-auth")
    expect(typeof OpenCodePlugin.setup).toBe("function")
  })

  test("separate magpie entry exports an OpenCode v1 plugin function", () => {
    expect(Object.keys(MagpieModule)).toEqual(["OpenCSGAuthPlugin"])
    expect(typeof MagpieModule.OpenCSGAuthPlugin).toBe("function")
  })

  test("registers OpenCSG, key auth, OAuth, and a public model catalog", async () => {
    globalThis.fetch = async () =>
      Response.json(
        modelPage([
          {
            id: "chat",
            task: "text-generation",
            support_function_call: true,
            context_length: 128_000,
          },
          { id: "embed", task: "text-embedding" },
        ]),
      )

    const { ctx, state } = context()
    const cleanup = await OpenCodePlugin.setup(ctx)
    await cleanup()

    expect(state.integrations.get("opencsg")).toEqual({
      id: "opencsg",
      name: "OpenCSG",
    })
    expect(state.methods.map((method) => method.type)).toEqual(["key", "oauth"])
    expect(state.methods[0]).toMatchObject({
      label: "OpenCSG API key",
      form: [
        { key: "gateway", type: "string" },
        { key: "systemOneURL", type: "string" },
      ],
    })
    expect(state.methods[1]).toMatchObject({
      id: "oauth",
      label: "Sign in with OpenCSG",
      form: [
        { key: "gateway", type: "string" },
        { key: "systemOneURL", type: "string" },
      ],
    })

    const provider = state.providers.get("opencsg")
    expect(provider.info).toMatchObject({
      id: "opencsg",
      integrationID: "opencsg",
      name: "OpenCSG",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "https://opencsg.com/aigateway/v1" },
    })
    expect(provider.models.map((model) => model.id)).toEqual(["chat"])
    expect(provider.models[0]).toMatchObject({
      id: "chat",
      modelID: "chat",
      providerID: "opencsg",
      name: "Chat",
      capabilities: {
        tools: true,
        input: ["text"],
        output: ["text"],
      },
      variants: [],
      status: "active",
      enabled: true,
      limit: { context: 128_000, output: 0 },
    })
    expect([...state.tools.keys()]).toEqual([
      "opencsg_models",
      "opencsg_generate_image",
      "opencsg_generate_video",
      "opencsg_video_status",
      "opencsg_system_one",
    ])
    expect(state.tools.get("opencsg_generate_image")).toMatchObject({
      options: { codemode: false },
      input: { type: "object" },
    })
    expect(state.transforms).toBe(1)
  })

  test("uses account credentials and a custom gateway", async () => {
    const connection = {
      type: "credential",
      id: "cred_1",
      label: "Work",
      method: "key",
    }
    const credential = {
      type: "key",
      key: "gw-sk-test",
      configuration: { gateway: "https://private.example/aigateway" },
    }
    let request
    globalThis.fetch = async (input, init) => {
      request = { url: String(input), headers: new Headers(init.headers) }
      return Response.json(modelPage([{ id: "private-chat", task: "text-generation" }]))
    }

    const { ctx, state } = context({ connection, credential })
    const cleanup = await OpenCodePlugin.setup(ctx)
    await cleanup()

    expect(request.url).toBe("https://private.example/aigateway/v1/models?page=1&per=100")
    expect(request.headers.get("authorization")).toBe("Bearer gw-sk-test")
    expect(state.providers.get("opencsg").info.settings.baseURL).toBe(
      "https://private.example/aigateway/v1",
    )
    expect(state.providers.get("opencsg").sourceConnection).toBe(connection)
    expect(state.providers.get("opencsg").models.map((model) => model.id)).toEqual([
      "private-chat",
    ])
    // OpenCode merges key form answers over provider/model settings. A custom
    // `gateway` answer must not replace the normalized OpenAI-compatible base.
    const runtime = {
      ...state.providers.get("opencsg").info.settings,
      ...state.providers.get("opencsg").models[0].settings,
      ...credential.configuration,
    }
    expect(`${runtime.baseURL}/chat/completions`).toBe(
      "https://private.example/aigateway/v1/chat/completions",
    )
  })

  test("tool calls use the active OpenCode credential without exposing it", async () => {
    const connection = {
      type: "credential",
      id: "cred_1",
      label: "Work",
      method: "key",
    }
    const credential = {
      type: "key",
      key: "gw-sk-test",
      configuration: { gateway: "https://private.example/aigateway" },
    }
    const calls = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      calls.push({ url, init, headers: new Headers(init?.headers) })
      if (url.pathname.endsWith("/models")) {
        return Response.json(
          modelPage([{ id: "image-a", task: "text-to-image" }]),
        )
      }
      if (url.pathname.endsWith("/images/generations")) {
        return Response.json({ data: [{ url: "https://cdn.example/a.png" }] })
      }
      throw new Error(`unexpected request ${url}`)
    }

    const { ctx, state } = context({ connection, credential })
    const cleanup = await OpenCodePlugin.setup(ctx)
    const result = await state.tools.get("opencsg_generate_image").execute(
      { prompt: "a lighthouse" },
      { signal: new AbortController().signal },
    )
    await cleanup()

    const imageCall = calls.find((call) => call.url.pathname.endsWith("/images/generations"))
    expect(imageCall.url.href).toBe(
      "https://private.example/aigateway/v1/images/generations",
    )
    expect(imageCall.headers.get("authorization")).toBe("Bearer gw-sk-test")
    expect(JSON.parse(imageCall.init.body)).toMatchObject({
      model: "image-a",
      prompt: "a lighthouse",
      response_format: "url",
    })
    expect(result.output).not.toContain("gw-sk-test")
    expect(JSON.parse(result.output).urls).toEqual(["https://cdn.example/a.png"])
  })

  test("keeps the provider visible and rebases retained models when discovery fails", async () => {
    const connection = {
      type: "credential",
      id: "cred_1",
      label: "Work",
      method: "key",
    }
    const credential = {
      type: "key",
      key: "gw-sk-test",
      configuration: { gateway: "https://private.example/aigateway" },
    }
    globalThis.fetch = async () => new Response("down", { status: 503 })

    const { ctx, state } = context({ connection, credential })
    const cleanup = await OpenCodePlugin.setup(ctx)
    await cleanup()

    const provider = state.providers.get("opencsg")
    expect(provider.info.settings.baseURL).toBe("https://private.example/aigateway/v1")
    expect(provider.sourceConnection).toBeUndefined()
    expect(provider.models.map((model) => model.id)).toEqual(["auto"])
    expect(provider.models[0].settings.baseURL).toBe("https://private.example/aigateway/v1")
  })

  test("reads gateway and key from OAuth metadata", () => {
    expect(
      _internal.credentialAuth({
        type: "oauth",
        access: "gw-sk-oauth",
        metadata: { baseURL: "https://opencsg.example/aigateway/v1" },
      }),
    ).toEqual({
      key: "gw-sk-oauth",
      baseURL: "https://opencsg.example/aigateway/v1",
      systemOneBase: "https://opencsg.example/aigateway/v1",
    })
  })

  test("accepts legacy baseURL key configuration", () => {
    expect(
      _internal.credentialAuth({
        type: "key",
        key: "gw-sk-legacy",
        configuration: { baseURL: "https://legacy.example/aigateway" },
      }),
    ).toEqual({
      key: "gw-sk-legacy",
      baseURL: "https://legacy.example/aigateway/v1",
      systemOneBase: "https://legacy.example/aigateway/v1",
    })
  })

  test("credential events refresh the captured catalog without adding transforms", async () => {
    let listener
    let credential
    const connection = {
      type: "credential",
      id: "cred_1",
      label: "Work",
      method: "key",
    }
    const base = context({ connection })
    base.ctx.event.subscribe = ({ signal }) => ({
      async *[Symbol.asyncIterator]() {
        listener = {
          next: async () => {
            if (signal.aborted) return { done: true }
            await new Promise((resolve) => setTimeout(resolve, 5))
            return {
              done: false,
              value: { type: "credential.updated", data: { integrationID: "opencsg" } },
            }
          },
        }
        while (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 5))
          yield { type: "credential.updated", data: { integrationID: "opencsg" } }
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      },
    })
    base.ctx.integration.connection.resolve = async () => credential
    globalThis.fetch = async () =>
      Response.json(modelPage([{ id: "chat", task: "text-generation" }]))

    const cleanup = await OpenCodePlugin.setup(base.ctx)
    await new Promise((resolve) => setTimeout(resolve, 30))
    credential = {
      type: "key",
      key: "gw-sk-test",
      configuration: { gateway: "https://private.example/aigateway" },
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    await cleanup()

    expect(base.state.transforms).toBe(1)
    expect(base.state.reloads).toBeGreaterThan(1)
  })
})
