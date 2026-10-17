# magpie-opencsg-auth

OpenCSG AI Gateway provider for **OpenCode v2** and **magpie**.

- Provider ID: `opencsg`
- Plugin ID: `magpie-opencsg-auth`
- Gateway: `https://opencsg.com/aigateway/v1`
- Login: OpenCSG API key or browser OAuth

## Features

- Uses the OpenAI-compatible OpenCSG AI Gateway.
- Discovers the signed-in account's chat models from `GET /v1/models`.
- Supports text and image-input models, tool calls, context limits and price
  metadata when OpenCSG publishes them.
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
magpie provider test opencsg
```

To use the local checkout instead:

```sh
magpie plugin add ./magpie-opencsg-auth
```

For API-key login, choose the API-key method instead of `oauth`. The optional
gateway prompt accepts the same URL forms described above.

## Model discovery

The plugin reads the live OpenCSG model catalog. It exposes text-generation and
image-text-to-text chat models; embedding, rerank, speech and image-generation
tasks are skipped.

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
