import { describe, expect, test } from "bun:test"
import { decodeMove, encodeMove, type Mandate, type Move } from "../src/protocol.js"
import { checkMove } from "../src/rules.js"

const seller: Mandate = { side: "sell", limitCents: 50000 }
const buyer: Mandate = { side: "buy", limitCents: 70000 }
const move = (type: "OFFER" | "COUNTER" | "ACCEPT", priceCents: number, text = "deal?"): Move => ({
    v: 1, moveId: "m1", orderId: "o1", listingId: "l1", from: "me", round: 1, text, sentAt: 0, type, priceCents,
})

describe("checkMove", () => {
    test("seller cannot go below floor", () => {
        expect(checkMove(seller, move("COUNTER", 49900), undefined, "me", 0)).toEqual({ ok: false, reason: "$499 is below your floor" })
        expect(checkMove(seller, move("COUNTER", 50000), undefined, "me", 0)).toEqual({ ok: true })
    })

    test("buyer cannot go above ceiling", () => {
        expect(checkMove(buyer, move("OFFER", 70100), undefined, "me", 0)).toEqual({ ok: false, reason: "$701 is above your ceiling" })
    })

    test("accept must match the other side's standing offer", () => {
        const reason = "can only accept the other side's current offer"
        expect(checkMove(buyer, move("ACCEPT", 60000), undefined, "me", 0)).toEqual({ ok: false, reason })
        expect(checkMove(buyer, move("ACCEPT", 60000), { priceCents: 60000, from: "me" }, "me", 0)).toEqual({ ok: false, reason })
        expect(checkMove(buyer, move("ACCEPT", 60000), { priceCents: 61000, from: "them" }, "me", 0)).toEqual({ ok: false, reason })
        expect(checkMove(buyer, move("ACCEPT", 60000), { priceCents: 60000, from: "them" }, "me", 0)).toEqual({ ok: true })
    })

    test("text cannot leak the limit", () => {
        expect(checkMove(seller, move("COUNTER", 65000, "I won't go under 500"), undefined, "me", 0))
            .toEqual({ ok: false, reason: "message would reveal your limit" })
        expect(checkMove(seller, move("COUNTER", 65000, "how about 650"), undefined, "me", 0)).toEqual({ ok: true })
        expect(checkMove(seller, move("COUNTER", 50000, "500 is my final offer"), undefined, "me", 0)).toEqual({ ok: true })
    })

    test("deadline blocks priced moves but not walking away", () => {
        const late: Mandate = { ...seller, deadlineAt: 10 }
        expect(checkMove(late, move("COUNTER", 60000), undefined, "me", 11)).toEqual({ ok: false, reason: "deadline passed" })
        expect(checkMove(late, { ...move("COUNTER", 1), type: "REJECT" } as Move, undefined, "me", 11)).toEqual({ ok: true })
    })
})

test("move survives the Relay text round trip", () => {
    const m = move("COUNTER", 64000, "$640 and I'll pick up tonight")
    expect(decodeMove(encodeMove(m))).toEqual(m)
    expect(decodeMove("just chatting")).toBeUndefined()
})
