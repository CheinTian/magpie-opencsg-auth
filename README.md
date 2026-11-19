# magpie-opencsg-auth

OpenCSG AI Gateway provider for **OpenCode v2** and **magpie**.

- Provider ID: `opencsg`
- Plugin ID: `magpie-opencsg-auth`
- Gateway: `https://opencsg.com/aigateway/v1`
- Login: OpenCSG API key or browser OAuth

## Features

- Uses the OpenAI-compatible OpenCSG AI Gateway.
- Discovers the signed-in account's chat, image, video and System One decision
  models from `GET /v1/models`.
- Supports text and image-input models, tool calls, context limits and price
  metadata when OpenCSG publishes them.
- Generates images through `/images/generations`.
- Creates and polls asynchronous video jobs through `/videos`.
- Answers typed questions through the System One `/systemone` endpoint.
- Supports private CSGHub / OpenCSG deployments through a custom gateway URL.
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
sign-in page, receives the callback on localhost, exchanges the login for an AI
Gateway key and saves that key. The browser must be able to reach the machine
running OpenCode; use API-key login on a headless host or a private gateway
that cannot complete this callback flow.

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
`/chat/completions` endpoints, including streaming.

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

For API-key login, choose the API-key method instead of `oauth`. The optional
gateway prompt accepts the same URL forms described above.

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
```

The package has no runtime dependencies. OAuth callback, JWT parsing and key
exchange are covered by unit tests; the complete OpenCode request path has
been tested against a local mock gateway. A real public OpenCSG OAuth login
still needs verification with a live account.

## License

MIT
