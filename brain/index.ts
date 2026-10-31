import { listen, takeTurn } from "./loop.js"
import { agentFor } from "./relay.js"
import { market, seed, startDemo } from "./seed.js"
import { serve } from "./server.js"

listen()
await seed()
const { userIds, orderIds } = await market.read()
await Promise.all(userIds.map(agentFor))
console.log(`brain up: ${userIds.length} agents, ${orderIds.length} orders`)
for (const id of orderIds) void takeTurn(id)
if (process.argv.includes("--demo")) console.log(`demo order ${await startDemo()} started`)
serve()
