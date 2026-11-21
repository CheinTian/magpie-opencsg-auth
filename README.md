# magpie-opencsg-auth

OpenCSG AI Gateway provider for **OpenCode v2** and **magpie**.

- Provider ID: `opencsg`
- Plugin ID: `magpie-opencsg-auth`
- Gateway: `https://opencsg.com/aigateway/v1`
- Login: OpenCSG API key or browser OAuth

## Features

- Advertises effective models on Chat Completions, Anthropic Messages and
  OpenAI Responses, and lets API-key or OAuth login bind each OpenCSG account
  to any one of those protocols (the loader refuses requests for the others).
- Supports a configurable System One URL, defaulting to the gateway's `/v1`
  base, and reports the active endpoints from `opencsg_models`.
- Discovers the signed-in account's chat, image, video and System One decision
  models from `GET /v1/models`.
- Supports text and image-input models, tool calls, context limits and price
  metadata when OpenCSG publishes them.
- Generates images through `/images/generations`.
- Creates and polls asynchronous video jobs through `/videos`.
- Answers typed questions through the System One `/systemone` endpoint.
- Supports private CSGHub / OpenCSG deployments through a custom gateway URL,
  including deriving the equivalent protocol endpoints from that URL.
- Exchanges an OpenCSG browser login for an AI Gateway key automatically; the
  short-lived CSGHub JWT is not stored.
- Marks credentials as expired on `401` / `403`, so OpenCode can prompt for a
  new login.

## Use in OpenCode

Requires OpenCode v2.

### 1. Install the plugin

```sh
opencode plugin add github:CheinTian/magpie-opencsg-auth
```

This adds the plugin to the global OpenCode configuration. Alternatively, add
it to `~/.config/opencode/opencode.json` manually:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:CheinTian/magpie-opencsg-auth"]
}
```

Restart OpenCode if the OpenCSG provider does not appear immediately:

```sh
opencode service restart
```

### 2. Sign in

Sign in with an existing API key:

```sh
opencode auth login opencsg --method key
```

Leave **Gateway URL** empty for the public OpenCSG service, then paste an API
key created at [opencsg.com](https://opencsg.com/) under **账号设置 → API
Keys**. The key is normally shown only once.

Or sign in through the browser:

```sh
opencode auth login opencsg --method oauth
```

Leave **Gateway URL** empty for the public service. OpenCode opens the OpenCSG
sign-in page and the platform returns the login to a fixed loopback callback,
`http://127.0.0.1:11437/api/cloud/auth/callback`, which the plugin is
listening on. It exchanges the returned CSGHub JWT for an AI Gateway key and
saves that key.

The callback address is the platform's built-in local sign-in target
(`OPENCSG_USER_SERVER_LITE_REDIRECT_URL`), and the sign-in asks the user
service for `state=lite` so the browser is sent there. OpenCSG's portal
callback only forwards a login to the portal itself, to callbacks registered
in `OPENCSG_USER_SERVER_FLOW_REDIRECTS`, or to that lite target; a plugin that
chose its own `http://127.0.0.1:<random port>` callback is rejected with
`opencsg.com/errors/server-error?error_code=500`.

Consequences:

- The browser must run on the same machine as OpenCode/magpie.
- Port `11437` must be free. `csghub-lite` (`csglite`) listens on the same
  loopback target (`server.AuthCallbackAddr`, default `127.0.0.1:11437`), so
  sign in with only one of them at a time. CSGClaw does not use it: it serves
  its own `/api/v1/auth/callback` on its listen address instead.
- A private deployment that changed `OPENCSG_USER_SERVER_LITE_REDIRECT_URL`
  needs the same URL in `OPENCSG_SIGNIN_CALLBACK`, e.g.
  `OPENCSG_SIGNIN_CALLBACK=http://127.0.0.1:11438/api/cloud/auth/callback`.
- Use API-key login on a headless host or when the browser cannot reach this
  machine's loopback address.

You can also run `/connect` in the OpenCode TUI, choose **OpenCSG**, and select
either **OpenCSG API key** or **Sign in with OpenCSG**.

### 3. Verify the connection

```sh
opencode models --standalone | grep '^opencsg/'
```

The public catalog is visible before login. After login, the account's own
catalog is used, including models available through its organization.

### 4. Run a prompt

Choose one of the model IDs printed by the previous command:

```sh
opencode run --standalone -m opencsg/<model> "用一句话介绍 OpenCSG"
```

In the TUI, open `/models` and select an `OpenCSG` model instead. After the
plugin has loaded, you can normally omit `--standalone`; it is useful for
testing a newly installed plugin against a fresh local server.

### Image, video and System One tools

OpenCode model selection stays focused on chat models. Media and decision
models are exposed as tools instead of being sent to `/chat/completions`:

- `opencsg_models` lists the account's chat, image, video and decision models.
- `opencsg_generate_image` calls OpenCSG image generation.
- `opencsg_generate_video` creates an asynchronous video job.
- `opencsg_video_status` reads a job and returns its content URL when ready.
- `opencsg_system_one` submits state plus named typed questions.

All tools discover model IDs dynamically. When `model` is omitted, the first
available model with the required task is used. If the account has no image,
video or System One model, the tool returns an explicit error instead of
inventing a model ID.

Image generation example:

```text
Use opencsg_generate_image with prompt "a paper-cut lighthouse at dusk"
```

Video generation is asynchronous. The create tool returns `id`, `status_url`
and, once complete, `content_url`. Poll with `opencsg_video_status` rather than
resubmitting the prompt. Direct OpenCSG content URLs require the same API key as
the gateway.

System One questions may use `noul`, `choice` or `score`. `choice` requires
`criteria`; `state` may be a string or structured JSON:

```json
{
  "state": { "ticket": "I was charged twice", "plan": "pro" },
  "questions": {
    "refund": {
      "type": "noul",
      "instructions": "Is the customer asking for money back?"
    },
    "intent": {
      "type": "choice",
      "instructions": "What do they want?",
      "criteria": ["refund", "technical help", "cancel"]
    }
  }
}
```

### Custom gateway

For a private CSGHub / OpenCSG deployment, enter its gateway URL during login.
These forms are accepted and normalized to the `/v1` base:

```text
https://ai-gateway.example.com
https://ai-gateway.example.com/aigateway
https://ai-gateway.example.com/aigateway/v1
```

The deployment must expose OpenAI-compatible `/models` and
`/chat/completions` endpoints, including streaming. Anthropic Messages,
Responses and System One are advertised when the deployment also exposes their
corresponding endpoints.

## Use in magpie

```sh
magpie plugin add github:CheinTian/magpie-opencsg-auth
magpie plugin login opencsg oauth
magpie plugin
magpie tools
magpie provider test opencsg
```

To use the local checkout instead:

```sh
magpie plugin add ./magpie-opencsg-auth
```

Browser sign-in uses the same loopback callback described for OpenCode above:
the browser must run on this machine and port `11437` must be free.

### Plan and balance

magpie shows each account's subscription plan and wallet balance on its usage
page. It reads them through `auth.usage`, a magpie-only hook; OpenCode has no
equivalent and shows no usage for this provider.

The plugin asks the CSGHub deployment that serves the gateway for:

- `GET /api/v1/accounting/credit/{user-uuid}/balance` - the wallet balance,
  whose `composition` splits cash and bonus credit;
- `GET /api/v1/accounting/token-plans/{namespace-uuid}/get` - the current
  token-plan subscription with its latest billing period.

CSGHub v2.8.2 and later accept an AI Gateway key (`gk_…`) only on the
inference routes; the portal answers `AUTH-ERR-5` to it everywhere else. Those
two reads therefore authenticate with the account's own CSGHub access token
instead. The platform already creates that token during sign-in: the lite
callback returns it as `token` (the token the user service creates or reuses
as `csglite`), and the plugin stores it in the account's metadata. Nothing is
created by the plugin, and the user never pastes a second credential. The
token is visible and revocable in the portal's access-token settings.

An account added by pasting a Gateway key has no signed-in session, so it has
no access token either. On v2.8.2 and later such an account shows no plan or
balance; on earlier deployments it still reads them with the Gateway key. Sign
in with OpenCSG to get the allowance back.

CSGHub keeps money in 分 (cents). Every amount is converted to 元 the way
csghub-portal does it (`amount / 100`), so a stored `550984.7` is shown as
`¥5,509.85`, and cash and bonus credit are listed beside it.

A token plan becomes one window per model quota of the current billing period,
in the unit the plan meters (`tokens` for text generation, ranking and
embeddings; `requests` for every other task), renewing when the period ends.
A model that reaches its cap therefore holds back only that model, not the
whole account. The plan's name and end date show as the account's plan, and a
subscription without an end date (an automatically renewing one) is marked as
renewing.

Private deployments degrade quietly. When the accounting service answers
nothing (community CSGHub runs none) or the namespace has no plan, the account
is still listed, with just its name and no error. Only a real failure - a
server error or an unreachable portal - surfaces as the usage card's error.

Reads are cached for 60 seconds.

For API-key login, choose the API-key method instead of `oauth`. The optional
gateway prompt accepts the same URL forms described above. The optional
**System One URL** prompt accepts either its `/v1` base or the full
`/systemone` URL; leave it empty to use the gateway base. The **Protocol this
account uses** prompt offers:

- **Any protocol** - the account may serve every advertised endpoint.
- **Anthropic Messages** - only `/v1/messages` and Anthropic token-counting
  requests use the account.
- **Chat Completions** - only `/v1/chat/completions` uses the account.
- **OpenAI Responses** - only `/v1/responses` uses the account.

The choice is stored with that account's credential metadata. Re-run
`magpie plugin login opencsg` to change it. A request for another protocol gets
a retryable `503` from the plugin loader, so magpie can move to an account that
supports it.

### Endpoints and protocol switching

The provider derives these endpoints:

- **OpenAI / Chat Completions** (`chat`)
- **Anthropic Messages** (`anthropic`)
- **OpenAI Responses** (`responses`)
- **System One** (`decide`)

For the public gateway the defaults are
`https://opencsg.com/aigateway/v1` for Chat Completions, Responses and System
One, and `https://opencsg.com/aigateway` for Anthropic Messages. Custom gateway
URLs are normalized and the same endpoints are derived automatically. Existing
config values are preserved.

Every chat model is advertised to magpie on all three conversation protocols.
Requests can therefore arrive as Chat Completions, Anthropic Messages or OpenAI
Responses, and the plugin forwards them to the same normalized gateway base.
The `opencsg_models` tool includes an `endpoints` object with the actual Chat,
Anthropic, Responses and System One URLs in use.

System One is enabled with the boolean `decide: true` that magpie's plugin host
expects; `decideURL` keeps the chosen endpoint. At sign-in, the **System One
URL** prompt can point System One at another gateway host. Existing sign-ins
derive it from their gateway automatically, and older `decide: true` values
continue to work.

> DeepSeek, oMLX and similar built-in providers use magpie's standard provider
> **key** rows, where the host draws its native "Any protocol / Anthropic /
> Chat Completions" pill. OpenCSG is a plugin-backed provider whose sign-ins are
> plugin **accounts**, and the current magpie host does not expose that native
> pill on plugin account rows. This plugin therefore offers the equivalent
> per-account choice in the login form and enforces it in the loader. Rendering
> the pill inline on plugin account rows requires a magpie host hook; it cannot
> be injected by a provider plugin alone.

> magpie's plugin-provider editor does not provide free-form endpoint fields
> for plugin-backed providers. Use the sign-in prompts, or edit the provider
> configuration below, to change a URL. Custom providers created directly in
> magpie retain magpie's native endpoint editor.

The equivalent provider configuration is:

```json
{
  "chat": "https://opencsg.com/aigateway/v1",
  "anthropic": "https://opencsg.com/aigateway",
  "responses": "https://opencsg.com/aigateway/v1",
  "decide": true,
  "decideURL": "https://opencsg.com/aigateway/v1",
  "baseAPI": "chat"
}
```

The plugin registers `opencsg_models`, `opencsg_generate_image`,
`opencsg_generate_video`, `opencsg_video_status` and `opencsg_system_one` for
every magpie agent. magpie prefixes these with the plugin name in its tool
list. Media tools call magpie's local gateway, so the OpenCSG account remains in
magpie's credential store and is never copied into tool arguments.

## Model discovery

The plugin reads the live OpenCSG model catalog and classifies models by task:

- `text-generation` and `image-text-to-text` are chat models.
- `text-to-image` and `image-to-image` are image models.
- `text-to-video`, `image-to-video` and related tasks are video models.
- `typed-decisions` is a System One decision model.

Embedding, rerank and speech tasks remain outside this provider. OpenCode's
chat model picker only includes chat models; the image, video and System One
tools use the wider catalog. magpie's provider registry receives all four
classes with the matching output modality or decision flag.

If OpenCSG does not publish context or output limits, the plugin leaves them at
`0` instead of inventing values. Prices are converted from CNY per million
tokens to USD for OpenCode/magpie cost estimates; those estimates do not
replace the OpenCSG invoice.

A failed catalog refresh keeps the provider and the last complete model list
visible instead of turning a temporary gateway outage into an empty provider.

## Security

The AI Gateway key is stored in OpenCode's or magpie's own credential store,
not in this repository. The short-lived CSGHub JWT used during browser login is
not saved.

## Development

```sh
bun test
bun run check
bun run login-check            # live browser sign-in, end to end
bun run login-check https://ai-gateway.example.com/aigateway/v1
```

The package has no runtime dependencies. OAuth callback, JWT parsing and key
exchange are covered by unit tests; the complete OpenCode request path has
been tested against a local mock gateway. `bun run login-check` runs the same
sign-in the plugin performs (authorize URL, loopback callback, key exchange,
`/models` check) against a real account without starting magpie or OpenCode.

## License

MIT
