import { Actor, Emittable, Persisted } from "terse-sdk/actor"
import type { Mandate, Move, Standing } from "./protocol.js"
import { checkMove, type Verdict } from "./rules.js"

export type ActivityEntry = { at: number; orderId?: string; kind: "decision" | "blocked" | "deal" | "info"; text: string }

const appendActivity = (list: ActivityEntry[], entry: Omit<ActivityEntry, "at">) =>
    [...list, { at: Date.now(), ...entry }].slice(-100)

// Owns everything private about a person: their limits never leave this actor except to their own agent.
export class User extends Actor {
    @Persisted @Emittable name = ""
    @Persisted agentName = ""
    @Persisted relayToken = ""
    @Persisted mandates: Record<string, Mandate> = {}
    @Persisted @Emittable activity: ActivityEntry[] = []
    @Persisted @Emittable escrowCents = 200000

    async setup(name: string, agentName: string) {
        this.name = name
        this.agentName = agentName
    }

    async setRelayToken(token: string) {
        this.relayToken = token
    }

    // What anyone watching the market may see. Mandates are deliberately absent.
    async publicView() {
        return { name: this.name, escrowCents: this.escrowCents, activity: this.activity }
    }

    async profile() {
        return { name: this.name, agentName: this.agentName, relayToken: this.relayToken }
    }

    async setMandate(listingId: string, mandate: Mandate) {
        this.mandates = { ...this.mandates, [listingId]: mandate }
    }

    // Only the owner's own agent asks for this, to brief its LLM.
    async mandate(listingId: string): Promise<Mandate | null> {
        return this.mandates[listingId] ?? null
    }

    async authorize(listingId: string, move: Move, standing: Standing | null, self: string): Promise<Verdict> {
        const m = this.mandates[listingId]
        if (!m) return { ok: false, reason: "no mandate for this listing" }
        const verdict = checkMove(m, move, standing ?? undefined, self, Date.now())
        if (!verdict.ok) this.activity = appendActivity(this.activity, { orderId: move.orderId, kind: "blocked", text: `Blocked ${move.type}: ${verdict.reason}` })
        return verdict
    }

    async log(entry: Omit<ActivityEntry, "at">) {
        this.activity = appendActivity(this.activity, entry)
    }

    async adjustEscrow(deltaCents: number) {
        return (this.escrowCents += deltaCents)
    }

}

export type ListingData = {
    id: string
    sellerId: string
    title: string
    condition: string
    askCents: number
    emoji: string
    status: "open" | "negotiating" | "sold"
}

export class Listing extends Actor {
    @Persisted @Emittable listing: ListingData | null = null

    async create(data: ListingData) {
        this.listing ??= data
        return this.listing
    }

    async read() {
        return this.listing
    }

    async setStatus(status: ListingData["status"]) {
        if (this.listing) this.listing = { ...this.listing, status }
    }
}

export type OrderData = {
    id: string
    listingId: string
    buyerId: string
    sellerId: string
    dmId?: string
    moves: Move[]
    turn: string | null
    standing?: Standing
    status: "open" | "deal" | "walked" | "expired"
    finalCents?: number
    escrow: "none" | "held" | "released"
}

export class Order extends Actor {
    @Persisted @Emittable order: OrderData | null = null

    async open(data: Pick<OrderData, "id" | "listingId" | "buyerId" | "sellerId">) {
        this.order ??= { ...data, moves: [], turn: data.buyerId, status: "open", escrow: "none" }
        return this.order
    }

    async read() {
        return this.order
    }

    async setDm(dmId: string) {
        if (this.order) this.order = { ...this.order, dmId }
    }

    async setEscrow(escrow: OrderData["escrow"]) {
        if (this.order) this.order = { ...this.order, escrow }
    }

    // Idempotent on moveId so a replayed Relay message after a restart is a no-op.
    async applyMove(move: Move): Promise<{ applied: boolean; reason?: string }> {
        const o = this.order
        if (!o) return { applied: false, reason: "no order" }
        if (o.moves.some((m) => m.moveId === move.moveId)) return { applied: false, reason: "duplicate" }
        if (o.status !== "open") return { applied: false, reason: `order is ${o.status}` }
        if (move.from !== o.turn) return { applied: false, reason: "not your turn" }
        if (move.type === "OFFER" && o.moves.length > 0) return { applied: false, reason: "OFFER only opens" }
        if (move.type !== "OFFER" && move.type !== "REJECT" && !o.standing) return { applied: false, reason: "nothing to respond to" }

        const other = move.from === o.buyerId ? o.sellerId : o.buyerId
        const moves = [...o.moves, move]
        if (move.type === "REJECT") {
            this.order = { ...o, moves, turn: null, status: "walked" }
        } else if (move.type === "ACCEPT") {
            if (o.standing?.from === move.from || o.standing?.priceCents !== move.priceCents)
                return { applied: false, reason: "ACCEPT must match the other side's offer" }
            this.order = { ...o, moves, turn: null, status: "deal", finalCents: move.priceCents }
        } else {
            this.order = { ...o, moves, turn: other, standing: { priceCents: move.priceCents, from: move.from } }
        }
        return { applied: true }
    }
}

// Index of everything, so the brain can resume open orders after a restart and the UI can list listings.
export class Market extends Actor {
    @Persisted @Emittable userIds: string[] = []
    @Persisted @Emittable listingIds: string[] = []
    @Persisted @Emittable orderIds: string[] = []

    async addUser(id: string) {
        if (!this.userIds.includes(id)) this.userIds = [...this.userIds, id]
    }

    async addListing(id: string) {
        if (!this.listingIds.includes(id)) this.listingIds = [...this.listingIds, id]
    }

    async addOrder(id: string) {
        if (!this.orderIds.includes(id)) this.orderIds = [...this.orderIds, id]
    }

    async read() {
        return { userIds: this.userIds, listingIds: this.listingIds, orderIds: this.orderIds }
    }
}
