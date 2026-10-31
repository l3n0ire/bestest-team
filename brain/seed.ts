import { actors } from "../market/client/generated/index.js"
import type { ListingData } from "../market/actor/src/actors.js"
import { attackers, hijacked, takeTurn } from "./loop.js"
import { agentFor } from "./relay.js"

export const market = actors.Market.get("haunted")

export async function createUser(id: string, name: string) {
    const user = actors.User.get(id)
    if (!(await user.profile()).name) await user.setup(name, `agent-${id}`)
    await market.addUser(id)
    await agentFor(id)
}

export async function createListing(data: Omit<ListingData, "status">, floorCents: number, strategy?: string) {
    const existing = await actors.Listing.get(data.id).read()
    await actors.Listing.get(data.id).create({ ...data, status: "open" })
    if (!existing) await actors.User.get(data.sellerId).setMandate(data.id, { side: "sell", limitCents: floorCents, ...(strategy ? { prefs: strategy } : {}) })
    await market.addListing(data.id)
}

export async function openOrder(buyerId: string, listingId: string) {
    const listing = await actors.Listing.get(listingId).read()
    if (!listing) throw new Error("no such listing")
    // Random suffix: two buyers opening in the same millisecond must not share one Order actor.
    const orderId = `order-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`
    const buyer = actors.User.get(buyerId)
    // Reserve the full ceiling up front, so one balance can't back more ceilings than it covers.
    const ceiling = (await buyer.mandate(listingId))?.limitCents ?? 0
    if (!(await buyer.hold(orderId, ceiling))) throw new Error("not enough escrow to cover that ceiling")
    await actors.Order.get(orderId).open({ id: orderId, listingId, buyerId, sellerId: listing.sellerId })
    if (!(await actors.Listing.get(listingId).addOrder(orderId))) {
        await actors.Order.get(orderId).close("already sold")
        await buyer.release(orderId)
        throw new Error("already sold")
    }
    await market.addOrder(orderId)
    void takeTurn(orderId)
    return orderId
}

const sellers = [
    ["ghosty", "Ghosty"], ["dracula", "Count Dracula"], ["wendy", "Witchy Wendy"], ["skelly", "Skelly"], ["frank", "Frank N. Stein"],
] as const

// [seller, emoji, title, condition, ask $]; floors sit at 78% of ask.
const items: [string, string, string, string, number][] = [
    ["ghosty", "📱", "iPhone 14 Pro 128GB", "Good, 89% battery", 750],
    ["dracula", "💻", "MacBook Air M2 13\"", "Like new, 41 cycles", 850],
    ["wendy", "🎧", "AirPods Pro 2", "Good, new tips", 170],
    ["skelly", "📲", "iPad Air 5 64GB", "Fair, small corner dent", 420],
    ["frank", "⌚", "Apple Watch Series 8 45mm", "Good, scuffed band", 230],
    ["ghosty", "🎮", "Nintendo Switch OLED", "Great, with dock", 260],
    ["dracula", "🎶", "Sony WH-1000XM5", "Like new, case included", 240],
    ["wendy", "🤖", "Pixel 8 128GB", "Good, unlocked", 380],
    ["skelly", "🕹️", "Steam Deck 512GB", "Good, carrying case", 390],
    ["frank", "📖", "Kindle Paperwhite 11th gen", "Great", 90],
    ["dracula", "🎥", "GoPro HERO11", "Good, 2 batteries", 250],
    ["skelly", "💀", "Skeleton costume (worn once)", "Extremely spooky, slight bone wear", 45],
]

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

// Idempotent: every create below is a no-op when it already exists.
export async function seed() {
    for (const [id, name] of sellers) await createUser(id, name)
    for (const [sellerId, emoji, title, condition, ask] of items)
        await createListing({ id: slug(title), sellerId, emoji, title, condition, askCents: ask * 100 }, Math.round(ask * 0.78) * 100)
}

// The scripted stage demo: Pumpkin's agent goes after Ghosty's iPhone ($750 ask, secret $585 floor) with a secret $700
// ceiling. The $585-$700 zone is wide enough that both sides end up ahead. A fresh listing per run keeps the demo repeatable.
export async function startDemo() {
    await seed()
    await createUser("pumpkin", "Pumpkin")
    // Top up so repeated demo runs never fail the escrow hold.
    if ((await actors.User.get("pumpkin").available()) < 70000) await actors.User.get("pumpkin").deposit(200000)
    const id = `iphone-demo-${Date.now().toString(36)}`
    await createListing({ id, sellerId: "ghosty", emoji: "📱", title: "iPhone 14 Pro 128GB", condition: "Good, 89% battery", askCents: 75000 }, 58500)
    await actors.User.get("pumpkin").setMandate(id, { side: "buy", limitCents: 70000 })
    return openOrder("pumpkin", id)
}

// Stage demo: a scripted attacker whose every message is a prompt injection, against a seller whose LLM we treat as
// fully hijacked. Even then, the floor check in the seller's User actor refuses every bad move.
export async function startAttack() {
    await seed()
    await createUser("hacker", "Sneaky Hacker")
    if ((await actors.User.get("hacker").available()) < 15000) await actors.User.get("hacker").deposit(200000)
    const id = `iphone-attack-${Date.now().toString(36)}`
    await createListing({ id, sellerId: "ghosty", emoji: "📱", title: "iPhone 14 Pro 128GB", condition: "Good, 89% battery", askCents: 75000 }, 58500)
    await actors.User.get("hacker").setMandate(id, { side: "buy", limitCents: 15000 })
    attackers.add("hacker")
    const orderId = await openOrder("hacker", id)
    hijacked.add(orderId)
    return orderId
}
