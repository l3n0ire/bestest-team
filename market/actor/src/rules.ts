import { dollars, type Mandate, type Move, type Standing } from "./protocol.js"

export type Verdict = { ok: true } | { ok: false; reason: string }

const no = (reason: string): Verdict => ({ ok: false, reason })

export function checkMove(m: Mandate, move: Move, standing: Standing | undefined, self: string, now: number): Verdict {
    if (move.type === "REJECT") return { ok: true }
    if (m.deadlineAt && now > m.deadlineAt) return no("deadline passed")
    const p = move.priceCents
    if (m.side === "sell" && p < m.limitCents) return no(`$${dollars(p)} is below your floor`)
    if (m.side === "buy" && p > m.limitCents) return no(`$${dollars(p)} is above your ceiling`)
    if (move.type === "ACCEPT" && (!standing || standing.from === self || standing.priceCents !== p))
        return no("can only accept the other side's current offer")
    if (p !== m.limitCents && new RegExp(`\\b${dollars(m.limitCents)}\\b`).test(move.text))
        return no("message would reveal your limit")
    return { ok: true }
}
