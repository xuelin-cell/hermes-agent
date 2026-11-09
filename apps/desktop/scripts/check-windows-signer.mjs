// Read-only release preflight: certificates are validated at signing time.
import { locateSignTool } from './resolve-windows-signer.mjs'
const signtool = await locateSignTool({ signing: true })
console.log(`[signing-preflight] ${signtool}`)
