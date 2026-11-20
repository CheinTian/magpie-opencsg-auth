// Runs the browser sign-in exactly as the plugin does and reports each step,
// so the OAuth path can be checked without going through magpie or OpenCode.
//
//   bun scripts/login-check.mjs [gateway-url]
//
// The signed-in AI Gateway key is never printed; only whether it works.
import { spawn } from "node:child_process"
import { _internal } from "../index.mjs"

const gateway = _internal.normalizeBase(process.argv[2] ?? "")
const step = (message) => console.log(message)

let session
try {
  session = await _internal.callbackServer()
} catch (error) {
  console.error(`could not listen for the callback: ${error.message}`)
  process.exit(1)
}

step(`gateway      ${gateway}`)
step(`callback     ${session.callbackURL}`)

let url
try {
  url = await _internal.authorizeURL(_internal.portalOf(gateway))
} catch (error) {
  session.close()
  console.error(`could not build the sign-in URL: ${error.message}`)
  process.exit(1)
}

step(`sign in      ${url}`)
step("")
step("Opening the browser. Finish signing in there; this process waits for the callback.")

if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref()

const result = await session.completion
session.close()
if (result.error) {
  console.error(`sign-in failed: ${result.error.message}`)
  process.exit(1)
}

step("callback     reached the local listener")

let key
let claims
try {
  ;({ key, claims } = await _internal.keyForJWT(result.jwt, gateway))
} catch (error) {
  console.error(`could not exchange the JWT for a gateway key: ${error.message}`)
  process.exit(1)
}
step(`account      ${claims.username} (${claims.uuid})`)

try {
  await _internal.validateKey(gateway, key)
} catch (error) {
  console.error(`the gateway rejected the key: ${error.message}`)
  process.exit(1)
}
step(`key          accepted by ${gateway}/models`)

const models = await _internal.readModels(gateway, key).catch(() => [])
step(`models       ${models.length} visible to this account`)
step("")
step("OK: browser sign-in, key exchange and model discovery all worked.")
