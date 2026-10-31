import { listen, reconcile, takeTurn } from "./loop.js"
import { agentFor } from "./relay.js"
import { market, seed, startDemo } from "./seed.js"
import { serve } from "./server.js"

listen()
// Terse may still be starting or restarting: retry boot instead of dying on the first unreachable actor.
let userIds: string[] = [], orderIds: string[] = []
for (let attempt = 1; ; attempt++) {
    try {
        await seed()
        ;({ userIds, orderIds } = await market.read())
        await Promise.all(userIds.map(agentFor))
        break
    } catch (err) {
        if (attempt >= 30) throw err
        console.warn(`boot attempt ${attempt} failed (${(err as Error).message}); retrying in 2s`)
        await Bun.sleep(2000)
    }
}
console.log(`brain up: ${userIds.length} agents, ${orderIds.length} orders`)
for (const id of orderIds) void takeTurn(id)
// Repairs whatever a crash interrupted: unfinished settles, holds of closed orders. Idempotent.
for (const id of orderIds) void reconcile(id).catch((err) => console.warn(`order ${id}: reconcile on boot failed: ${err.message}`))
if (process.argv.includes("--demo")) console.log(`demo order ${await startDemo()} started`)
serve()
