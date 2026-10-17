# opencode-opencsg-auth

OpenCSG AI Gateway as an OpenCode / magpie provider.

Provider id: `opencsg`.

## What it does

- Signs in with an OpenCSG API key (`gw-sk-…`) or browser OAuth.
- Exchanges the browser login for an AI Gateway key automatically. The
  short-lived CSGHub JWT is not stored.
- Uses the OpenAI-compatible AI Gateway endpoint
  `https://opencsg.com/aigateway/v1`.
- Discovers the account's models from `GET /v1/models`, including task,
  tool-call, image-input and price metadata when OpenCSG publishes it.
- Supports private CSGHub / OpenCSG deployments through a configurable
  gateway URL.
- Streams Chat Completions responses through unchanged.
- Marks an account as needing sign-in again on `401` / `403`, so magpie can
  move to another account or provider.

## Install

From this folder:

```sh
magpie plugin add ./opencode-opencsg-auth
magpie plugin
magpie plugin login opencsg oauth
magpie provider test opencsg
```

The public model catalog can be read before signing in. After sign-in the
account's own catalog is used, including models available through its
organization.

For OpenCode, add the folder or npm package to `opencode.json` under
`plugin`, then run `/connect` and choose OpenCSG.

## Sign-in

There are two methods:

- **Sign in with OpenCSG** opens the OpenCSG IAM page, waits for a local
  callback, then creates or reads the account's built-in AI Gateway key
  automatically. This is the default for `magpie plugin login opencsg oauth`.
- **OpenCSG API key** accepts an existing `gw-sk-…` key. Sign in at
  [opencsg.com](https://opencsg.com/), open **账号设置 → API Keys** (or an
  organization's **API Keys** page), create a key and paste the full value.
  It is shown only once.

An API key entered this way is saved by magpie as-is. Its first live model
refresh or request is what tells whether OpenCSG accepts it.

For OAuth with a public OpenCSG deployment, the plugin follows the authorize
URL from `/login` and uses the public IAM app as a fallback. A private CSGHub
deployment must expose its own `/login` redirect with a callback URI that
accepts external `state` URLs. The gateway URL prompt accepts either the host
root, `/aigateway`, or `/aigateway/v1`.

On a headless or Docker host, magpie may ask you to paste the final callback
URL. This is normal: the local callback listener runs inside the machine that
runs magpie.

The API key method asks for the optional gateway URL first, then magpie asks
for the key itself. The OAuth method asks only for the optional gateway URL and
opens the browser.

The gateway URL prompt is optional. Leave it empty for the public
OpenCSG gateway, or enter a private deployment's base URL. Both forms are
accepted:

```text
https://opencsg.com/aigateway
https://opencsg.com/aigateway/v1
```

The resulting AI Gateway key is stored as an API key in magpie's
`plugin-auth.json` (or OpenCode's own auth store), not in this repository.
The short-lived CSGHub JWT used during sign-in is not saved.

OAuth-fetched keys are checked against `GET /v1/models` before they are saved.

## Models

The plugin reads the live OpenCSG model catalog. Text-generation and
image-text-to-text models are exposed; speech, embedding, rerank and image
generation tasks are skipped because this is a chat provider.

Before sign-in, the catalog is fetched from the public OpenCSG gateway. The
gateway currently reports 23 models, of which the plugin exposes the 18 chat
models. Model availability can differ by account or organization.

OpenCSG's list does not always publish context or output limits. In that case
the plugin leaves the limits at `0`, which lets magpie fall back to its own
catalog and user settings rather than inventing a window.

Prices in the OpenCSG response are in CNY per million tokens. The plugin
converts them to USD for OpenCode/magpie cost estimates. Those estimates do
not replace the OpenCSG invoice.

## Custom deployments

For a private CSGHub deployment, enter its gateway URL during sign-in, for
example:

```text
https://ai-gateway.example.com/v1
```

The deployment must expose the OpenAI-compatible `/chat/completions`,
`/models` and streaming endpoints. The URL may point at the host root,
`/aigateway`, or `/aigateway/v1`; the plugin normalizes it to the gateway's
`/v1` base.

For example, a gateway mounted at `https://opencsg.example.com/aigateway`
accepts requests at
`https://opencsg.example.com/aigateway/v1/chat/completions`.

## Develop

```sh
bun test
bun run check
```

There are no runtime dependencies.

## License

MIT
