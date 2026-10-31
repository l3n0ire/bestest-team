import { listen, settle, takeTurn } from "./loop.js"
import { agentFor } from "./relay.js"
import { market, seed, startDemo } from "./seed.js"
import { serve } from "./server.js"

listen()
await seed()
const { userIds, orderIds } = await market.read()
await Promise.all(userIds.map(agentFor))
console.log(`brain up: ${userIds.length} agents, ${orderIds.length} orders`)
for (const id of orderIds) void takeTurn(id)
// Finishes any settle a crash interrupted; a no-op for orders that aren't unreleased deals.
for (const id of orderIds) void settle(id).catch((err) => console.warn(`order ${id}: settle on boot failed: ${err.message}`))
if (process.argv.includes("--demo")) console.log(`demo order ${await startDemo()} started`)
serve()
