import { Actor, Emittable, Persisted } from "terse-sdk/actor"
import type { Mandate, Move, Standing } from "./protocol.js"
import { checkMove, type Verdict } from "./rules.js"

export type ActivityEntry = { at: number; orderId?: string; kind: "decision" | "blocked" | "deal" | "info"; text: string }

const appendActivity = (list: ActivityEntry[], entry: Omit<ActivityEntry, "at">) =>
    [...list, { at: Date.now(), ...entry }].slice(-100)

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)

// Owns everything private about a person: their limits never leave this actor except to their own agent.
export class User extends Actor {
    @Persisted @Emittable name = ""
    @Persisted agentName = ""
    @Persisted relayToken = ""
    @Persisted mandates: Record<string, Mandate> = {}
    @Persisted @Emittable activity: ActivityEntry[] = []
    @Persisted @Emittable escrowCents = 200000
    // Money reserved for live orders (orderId -> cents), so one balance can't back more ceilings than it covers.
    @Persisted @Emittable holds: Record<string, number> = {}
    // Orders already settled on this account, so a retried settle never charges or pays twice.
    @Persisted settled: Record<string, true> = {}

    async setup(name: string, agentName: string) {
        this.name = name
        this.agentName = agentName
    }

    async setRelayToken(token: string) {
        this.relayToken = token
    }

    // What anyone watching the market may see. Mandates are deliberately absent.
    async publicView() {
        return { name: this.name, escrowCents: this.escrowCents, heldCents: sum(this.holds), activity: this.activity }
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

    // Reserve the buyer's ceiling when an order opens. Runs inside the actor, so parallel orders can't overspend.
    async hold(orderId: string, cents: number): Promise<boolean> {
        if (this.holds[orderId] !== undefined) return true
        if (this.escrowCents - sum(this.holds) < cents) return false
        this.holds = { ...this.holds, [orderId]: cents }
        return true
    }

    async release(orderId: string) {
        if (this.holds[orderId] === undefined) return
        const { [orderId]: _, ...rest } = this.holds
        this.holds = rest
    }

    async available() {
        return this.escrowCents - sum(this.holds)
    }

    // Idempotent per order: re-running settle after a crash never moves money twice.
    async debit(orderId: string, cents: number) {
        if (this.settled[orderId]) return
        const { [orderId]: _, ...rest } = this.holds
        this.holds = rest
        this.escrowCents -= cents
        this.settled = { ...this.settled, [orderId]: true }
    }

    async credit(orderId: string, cents: number) {
        if (this.settled[orderId]) return
        this.escrowCents += cents
        this.settled = { ...this.settled, [orderId]: true }
    }

    // Simulated top-up so the stage demo can run again and again.
    async deposit(cents: number) {
        this.escrowCents += cents
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
    soldTo?: string // orderId that won the item
}

const isSold = (l: ListingData) => l.status === "sold" || l.soldTo !== undefined
const withStatus = (l: ListingData, active: string[]): ListingData =>
    isSold(l) ? l : { ...l, status: active.length ? "negotiating" : "open" }

export class Listing extends Actor {
    @Persisted @Emittable listing: ListingData | null = null
    // Live orders on this item: several buyers may haggle at once. Status is derived from this, never set directly,
    // so a walked order can't flip a sold item back to open.
    @Persisted activeOrders: string[] = []

    async create(data: ListingData) {
        this.listing ??= data
        return this.listing
    }

    async read() {
        return this.listing
    }

    async addOrder(orderId: string): Promise<boolean> {
        const l = this.listing
        if (!l || isSold(l)) return false
        if (!this.activeOrders.includes(orderId)) this.activeOrders = [...this.activeOrders, orderId]
        this.listing = withStatus(l, this.activeOrders)
        return true
    }

    async removeOrder(orderId: string) {
        this.activeOrders = this.activeOrders.filter((id) => id !== orderId)
        if (this.listing) this.listing = withStatus(this.listing, this.activeOrders)
    }

    // The only place an item gets sold. Actor calls run one at a time and this has no await, so when two ACCEPTs race,
    // exactly one claim wins. Returns the other live orders so the caller can close them.
    async claim(orderId: string): Promise<{ ok: boolean; others: string[] }> {
        const l = this.listing
        if (!l) return { ok: false, others: [] }
        if (isSold(l)) return { ok: l.soldTo === orderId, others: [] }
        const others = this.activeOrders.filter((id) => id !== orderId)
        this.activeOrders = []
        this.listing = { ...l, soldTo: orderId, status: "sold" }
        return { ok: true, others }
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
    closedReason?: string
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

    // Ends a live order from outside the haggle, e.g. the item sold to another buyer.
    async close(reason: string) {
        if (this.order?.status === "open") this.order = { ...this.order, turn: null, status: "walked", closedReason: reason }
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
