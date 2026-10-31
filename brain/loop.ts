import { actors } from "../market/client/generated/index.js"
import type { OrderData } from "../market/actor/src/actors.js"
import type { Verdict } from "../market/actor/src/rules.js"
import { decodeMove, dollars, encodeMove, type Move } from "../market/actor/src/protocol.js"
import { fixedStrategy, llmStrategy, MAX_MOVES, type Context, type Decision } from "./negotiate.js"
import { agentFor, relay } from "./relay.js"

const inFlight = new Set<string>()
// Slows the haggle down enough for an audience to read each bubble.
const PACE_MS = 1000

// Drops `reasoning`: it's for the owner's activity log and must not travel to the other agent.
const toMove = ({ reasoning: _, ...d }: Decision, order: OrderData, self: string): Move => ({
    ...d,
    v: 1,
    moveId: crypto.randomUUID(),
    orderId: order.id,
    listingId: order.listingId,
    from: self,
    round: order.moves.length,
    sentAt: Date.now(),
})

const describe = (m: Move) => ("priceCents" in m ? `${m.type} $${dollars(m.priceCents)}` : m.type)

// Decide, authorize against the owner's limit, record, then send over Relay. Nothing unauthorized hits the wire.
export async function takeTurn(orderId: string) {
    const order = await actors.Order.get(orderId).read()
    if (!order || order.status !== "open" || !order.turn) return
    const key = `${orderId}:${order.moves.length}`
    if (inFlight.has(key)) return
    inFlight.add(key)

    const self = order.turn
    const user = actors.User.get(self)
    const [mandate, listing] = await Promise.all([user.mandate(order.listingId), actors.Listing.get(order.listingId).read()])
    if (!mandate || !listing) return
    // Sold to another buyer while this order waited for its turn: nothing left to haggle over.
    if (listing.status === "sold" && listing.soldTo !== orderId) return closeOrder(orderId, "sold to another buyer")

    const ctx: Context = { order, mandate, listing, self }
    const { move, reasoning } = await decide(ctx, (m) => user.authorize(order.listingId, m, order.standing ?? null, self))
    await user.log({ orderId, kind: "decision", text: `${describe(move)}: ${reasoning}` })

    // Claim the item before an ACCEPT goes out. If another order got there first, this one closes instead of selling twice.
    let others: string[] = []
    if (move.type === "ACCEPT") {
        const claim = await actors.Listing.get(order.listingId).claim(orderId)
        if (!claim.ok) return closeOrder(orderId, "sold to another buyer")
        others = claim.others
    }

    const result = await actors.Order.get(orderId).applyMove(move)
    if (!result.applied) return console.warn(`order ${orderId}: ${describe(move)} not applied (${result.reason})`)

    const other = self === order.buyerId ? order.sellerId : order.buyerId
    const [{ agentName: to }, agent] = await Promise.all([actors.User.get(other).profile(), agentFor(self)])
    const sent = await agent.sendMessage({ to: `@${to}`, text: encodeMove(move) })
    if (!order.dmId && sent.conversationId) await actors.Order.get(orderId).setDm(sent.conversationId)
    console.log(`→ ${self}: ${describe(move)}  "${move.text}"`)

    if (move.type === "ACCEPT") {
        await settle(orderId)
        await Promise.all(others.map((id) => closeOrder(id, "sold to another buyer")))
    }
    if (move.type === "REJECT") await release(order)
}

// The order is over without a sale: free the item for others (unless sold) and give the buyer's reserved money back.
async function release(order: OrderData) {
    await Promise.all([actors.Listing.get(order.listingId).removeOrder(order.id), actors.User.get(order.buyerId).release(order.id)])
}

async function closeOrder(orderId: string, reason: string) {
    const order = await actors.Order.get(orderId).read()
    if (!order || order.status !== "open") return
    await actors.Order.get(orderId).close(reason)
    await release(order)
    await actors.User.get(order.buyerId).log({ orderId, kind: "info", text: `Order closed: ${reason}. Your hold was released.` })
    console.log(`✖ ${orderId}: ${reason}`)
}

// LLM first; if the marketplace blocks it, the LLM gets one retry with the reason, then the fixed strategy, then walk away.
// Hard round cap in code: at MAX_MOVES the LLM is skipped and the fixed strategy must ACCEPT or REJECT, so every order ends.
async function decide(ctx: Context, authorize: (m: Move) => Promise<Verdict>) {
    let blocked: string | undefined
    const fixed = async () => fixedStrategy(ctx)
    const attempts = ctx.order.moves.length >= MAX_MOVES
        ? [fixed]
        : [() => llmStrategy(ctx), async () => (blocked ? llmStrategy(ctx, blocked) : undefined), fixed]
    for (const attempt of attempts) {
        const decision = await attempt()
        if (!decision) continue
        const move = toMove(decision, ctx.order, ctx.self)
        const verdict = await authorize(move)
        if (verdict.ok) return { move, reasoning: decision.reasoning }
        blocked = verdict.reason
    }
    const reasoning = `Walking away: ${blocked}`
    return { move: toMove({ type: "REJECT", text: "I'll pass.", reasoning }, ctx.order, ctx.self), reasoning }
}

// Extension point for closed deals (e.g. a Supabase write). Runs at least once per deal, before escrow is marked
// released, so make the handler idempotent on order.id (an upsert).
export const onDeal: ((order: OrderData) => Promise<void>)[] = []

// Simulated escrow: take the buyer's money (consuming their hold), then pay the seller. Every step is idempotent per
// order, so this is safe to re-run; on boot it runs for every deal, which finishes a settle a crash interrupted.
export async function settle(orderId: string) {
    const order = await actors.Order.get(orderId).read()
    if (!order || order.status !== "deal" || !order.finalCents || order.escrow === "released") return
    const price = order.finalCents
    await actors.User.get(order.buyerId).debit(orderId, price)
    await actors.Order.get(orderId).setEscrow("held")
    await actors.User.get(order.sellerId).credit(orderId, price)
    for (const hook of onDeal) await hook(order).catch((err) => console.warn(`onDeal hook failed for ${orderId}: ${err.message}`))
    await actors.Order.get(orderId).setEscrow("released")
    const text = `Deal closed at $${dollars(price)}. Escrow released (simulated).`
    await Promise.all([order.buyerId, order.sellerId].map((id) => actors.User.get(id).log({ orderId, kind: "deal", text })))
    console.log(`✅ ${text}`)
}

export function listen() {
    relay.addListener("dm.received", async ({ message }) => {
        const move = decodeMove(message.text ?? "")
        if (!move) return
        // The sender already applied it; this is a no-op unless the sender crashed between apply and send.
        await actors.Order.get(move.orderId).applyMove(move)
        await Bun.sleep(PACE_MS)
        await takeTurn(move.orderId)
    })
}
