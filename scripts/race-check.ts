// Fires concurrent calls straight at the actors to prove the double-booking guards hold.
// Needs `terse actor dev` running (market/actor). Run from the repo root: bun scripts/race-check.ts
import { actors } from "../market/client/generated/index.js"

const run = Date.now().toString(36)
let failed = 0
const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failed++
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`)
}

// 1. Two orders ACCEPT the same item at the same instant: exactly one claim may win.
const listing = actors.Listing.get(`race-${run}`)
await listing.create({ id: `race-${run}`, sellerId: "nobody", title: "Race item", condition: "test", askCents: 10000, emoji: "🧪", status: "open" })
await Promise.all(["a", "b", "c"].map((o) => listing.addOrder(o)))
const claims = await Promise.all(["a", "b", "c"].map((o) => listing.claim(o)))
const winners = claims.filter((c) => c.ok).length
check("claim", winners === 1, `${winners} of 3 simultaneous claims won; others to close: ${JSON.stringify(claims.find((c) => c.ok)?.others)}`)
check("sold stays sold", (await listing.addOrder("late")) === false, "a new order on a sold item is refused")
await listing.removeOrder("a")
check("walk can't reopen", (await listing.read())?.status === "sold", `status after a removeOrder: ${(await listing.read())?.status}`)

// 2. One $2,000 balance backing three $800 ceilings at once: only two holds may succeed.
const buyer = actors.User.get(`buyer-${run}`)
const holds = await Promise.all(["h1", "h2", "h3"].map((o) => buyer.hold(o, 80000)))
check("hold", holds.filter(Boolean).length === 2, `${holds.filter(Boolean).length} of 3 holds succeeded, available now $${(await buyer.available()) / 100}`)

// 3. Settle retried after a crash: debit/credit must apply once per order. Use an order whose hold actually succeeded.
const won = ["h1", "h2", "h3"].find((_, i) => holds[i])!
const before = (await buyer.publicView()).escrowCents
await Promise.all([buyer.debit(won, 50000), buyer.debit(won, 50000)])
const after = (await buyer.publicView()).escrowCents
check("debit idempotent", before - after === 50000, `charged $${(before - after) / 100} for two debits of the same order (want $500)`)
const seller = actors.User.get(`seller-${run}`)
const s0 = (await seller.publicView()).escrowCents
await seller.credit(won, 50000)
await seller.credit(won, 50000)
check("credit idempotent", (await seller.publicView()).escrowCents - s0 === 50000, "seller paid once for two credits of the same order")
const heldAfter = (await buyer.publicView()).heldCents
check("debit consumed hold", heldAfter === 80000, `held after settle: $${heldAfter / 100} (want $800, the one other live hold)`)

console.log(failed ? `\n${failed} check(s) failed` : "\nall concurrency checks passed")
process.exit(failed ? 1 : 0)
