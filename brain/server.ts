import { actors } from "../market/client/generated/index.js"
import { createListing, createUser, market, openOrder, startDemo } from "./seed.js"

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24)
const dollarsToCents = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.round(n) * 100 : undefined
}
const bad = (error: string) => Response.json({ error }, { status: 400 })

// Public market snapshot. Mandates (limits) are never part of it.
async function snapshot() {
    const { userIds, listingIds, orderIds } = await market.read()
    const [listings, orders, users] = await Promise.all([
        Promise.all(listingIds.map((id) => actors.Listing.get(id).read())),
        Promise.all(orderIds.map((id) => actors.Order.get(id).read())),
        Promise.all(userIds.map(async (id) => ({ id, ...(await actors.User.get(id).publicView()) }))),
    ])
    return { listings: listings.filter(Boolean), orders: orders.filter(Boolean), users }
}

type Body = Record<string, unknown>

const routes: Record<string, (b: Body) => Promise<Response>> = {
    async join(b) {
        const name = String(b.name ?? "").trim().slice(0, 24)
        const id = slug(name)
        if (!id) return bad("pick a name")
        await createUser(id, name)
        return Response.json({ id })
    },
    async sell(b) {
        const sellerId = String(b.userId ?? "")
        const title = String(b.title ?? "").trim().slice(0, 60)
        const ask = dollarsToCents(b.askDollars)
        const floor = dollarsToCents(b.floorDollars)
        if (!sellerId || !title || !ask || !floor) return bad("need a title, ask and floor")
        if (floor > ask) return bad("floor can't be above the ask")
        const id = `${slug(title)}-${Date.now().toString(36)}`
        await createListing({ id, sellerId, title, condition: String(b.condition ?? "Used").slice(0, 60), askCents: ask, emoji: String(b.emoji || "📦").slice(0, 4) }, floor)
        return Response.json({ id })
    },
    async buy(b) {
        const buyerId = String(b.userId ?? "")
        const listingId = String(b.listingId ?? "")
        const ceiling = dollarsToCents(b.ceilingDollars)
        const listing = await actors.Listing.get(listingId).read()
        if (!buyerId || !listing || !ceiling) return bad("need a listing and a ceiling")
        if (listing.status === "sold") return bad("already sold")
        if (listing.sellerId === buyerId) return bad("that's your own listing")
        const deadlineSec = Number(b.deadlineSec)
        await actors.User.get(buyerId).setMandate(listingId, {
            side: "buy",
            limitCents: ceiling,
            ...(deadlineSec > 0 ? { deadlineAt: Date.now() + deadlineSec * 1000 } : {}),
            ...(b.prefs ? { prefs: String(b.prefs).slice(0, 120) } : {}),
        })
        return Response.json({ orderId: await openOrder(buyerId, listingId) })
    },
    async demo() {
        return Response.json({ orderId: await startDemo() })
    },
}

export function serve(port = Number(process.env.PORT ?? 3000)) {
    Bun.serve({
        port,
        async fetch(req) {
            const { pathname } = new URL(req.url)
            if (pathname === "/") return new Response(Bun.file(new URL("../web/index.html", import.meta.url)))
            if (pathname === "/api/state") return Response.json(await snapshot())
            const route = req.method === "POST" && routes[pathname.replace("/api/", "")]
            if (!route) return new Response("not found", { status: 404 })
            try {
                return await route((await req.json().catch(() => ({}))) as Body)
            } catch (err) {
                return bad((err as Error).message)
            }
        },
    })
    console.log(`UI on http://localhost:${port}`)
}
