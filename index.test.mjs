import { afterEach, describe, expect, test } from "bun:test"

import { _internal } from "./index.mjs"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
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

  test("uses the authorize endpoint discovered from /login", async () => {
    let request
    globalThis.fetch = async (input, init) => {
      request = { url: String(input), init }
      return new Response(null, {
        status: 303,
        headers: { location: "https://iam.opencsg.com/login/oauth/authorize?client_id=client" },
      })
    }

    const callback = "http://127.0.0.1:4567/callback?nonce=test"
    const url = await _internal.discoverAuthorizeURL("https://opencsg.com", callback)
    const parsed = new URL(url)

    expect(request.url).toBe("https://opencsg.com/login")
    expect(request.init.redirect).toBe("manual")
    expect(parsed.origin).toBe("https://iam.opencsg.com")
    expect(parsed.searchParams.get("client_id")).toBe("client")
    expect(parsed.searchParams.get("state")).toBe(callback)
  })

  test("falls back to the public IAM app only for opencsg.com", async () => {
    globalThis.fetch = async () => new Response("down", { status: 503 })
    const callback = "http://127.0.0.1:4567/callback?nonce=test"

    const url = await _internal.authorizeURL("https://opencsg.com", callback)
    const parsed = new URL(url)
    expect(parsed.origin).toBe("https://iam.opencsg.com")
    expect(parsed.searchParams.get("client_id")).toBe("d623c957e69976c8a7a8")
    expect(parsed.searchParams.get("state")).toBe(callback)

    await expect(_internal.authorizeURL("https://private.example", callback)).rejects.toThrow(
      "Could not start OpenCSG sign-in",
    )
  })

  test("accepts exactly one nonce-bound callback", async () => {
    const session = await _internal.callbackServer()
    const callback = new URL(session.callbackURL)
    const token = jwt({ current_user: "alice", uuid: "user-uuid" })

    const bad = await fetch(`${callback.origin}/callback?nonce=wrong&jwt_token=${token}`)
    expect(bad.status).toBe(400)

    const good = await fetch(`${callback.origin}${callback.pathname}${callback.search}&jwt_token=${token}`)
    expect(good.status).toBe(200)
    await expect(session.completion).resolves.toEqual({ jwt: token })

    const repeated = await fetch(`${callback.origin}${callback.pathname}${callback.search}&jwt_token=${token}`)
    expect(repeated.status).toBe(200)
    session.close()
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

describe("model metadata", () => {
  test("normalizes task lists and comma-separated tasks", () => {
    const tasks = _internal.tasksOf({
      task: "text-generation, image-text-to-text",
      metadata: { tasks: ["text-generation", "text-generation"] },
    })

    expect([...tasks]).toEqual(["text-generation", "image-text-to-text"])
  })

  test("skips non-chat tasks and maps chat capabilities", () => {
    const provider = { models: {} }
    const models = _internal.liveModels(
      [
        { id: "chat", task: "text-generation", support_function_call: true },
        { id: "vision", task: "image-text-to-text" },
        { id: "embed", task: "text-embedding" },
        { id: "rerank", metadata: { tasks: ["rerank"] } },
      ],
      provider,
    )

    expect(Object.keys(models)).toEqual(["chat", "vision"])
    expect(models.chat.tool_call).toBe(true)
    expect(models.chat.capabilities.toolcall).toBe(true)
    expect(models.chat.attachment).toBe(false)
    expect(models.vision.attachment).toBe(true)
    expect(models.vision.modalities.input).toEqual(["text", "image"])
    expect(models.chat.api).toEqual({
      id: "chat",
      npm: "@ai-sdk/openai-compatible",
    })
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
    })
    expect(Object.keys(cfg.provider.opencsg.models)).toEqual(["auto"])
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
    expect(methods[0].prompts.map((prompt) => prompt.key)).toEqual(["baseURL"])
    expect(methods[1].prompts[0].key).toBe("baseURL")

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
    expect(new URL(authorization.url).searchParams.get("state")).toStartWith(
      "http://127.0.0.1:",
    )
    expect(authorization.url).toContain(encodeURIComponent("http://127.0.0.1:"))
    const callback = new URL(new URL(authorization.url).searchParams.get("state"))
    await fetch(callback)
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
      metadata: { baseURL: "https://private.example/v1" },
    }
    const hooks = await load(auth)
    const loader = await hooks.auth.loader(async () => auth)
    const signal = new AbortController().signal
    let request
    globalThis.fetch = async (input, init) => {
      request = { input, init }
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

    expect(request.input).toBe("https://private.example/v1/chat/completions")
    expect(request.init.headers.get("authorization")).toBe("Bearer gw-sk-test")
    expect(request.init.headers.get("x-opencsg-client")).toBe("opencsg-magpie/0.1.0")
    expect(request.init.headers.get("content-length")).toBeNull()
    expect(request.init.signal).toBe(signal)
    expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
    expect(loader.baseURL).toBe("https://private.example/v1")
  })

  test("loader stays empty when no account is signed in", async () => {
    const hooks = await load(undefined)
    const loader = await hooks.auth.loader(async () => undefined)

    expect(loader).toEqual({})
  })
})
