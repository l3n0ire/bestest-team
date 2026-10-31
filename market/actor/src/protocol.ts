import { z } from "zod"

const Base = z.object({
    v: z.literal(1),
    moveId: z.string(),
    orderId: z.string(),
    listingId: z.string(),
    from: z.string(),
    round: z.number().int().nonnegative(),
    text: z.string().max(200),
    sentAt: z.number(),
})
const Price = z.number().int().positive()

export const Move = z.discriminatedUnion("type", [
    Base.extend({ type: z.literal("OFFER"), priceCents: Price }),
    Base.extend({ type: z.literal("COUNTER"), priceCents: Price }),
    Base.extend({ type: z.literal("ACCEPT"), priceCents: Price }),
    Base.extend({ type: z.literal("REJECT") }),
])
export type Move = z.infer<typeof Move>
export type PricedMove = Extract<Move, { priceCents: number }>

export type Side = "buy" | "sell"
export type Mandate = { side: Side; limitCents: number; deadlineAt?: number; prefs?: string }
export type Standing = { priceCents: number; from: string }

// Relay drops message metadata, so the move rides at the end of the text after "§".
const MARK = "\n§"

export function encodeMove(move: Move): string {
    return move.text + MARK + JSON.stringify(move)
}

export function decodeMove(text: string): Move | undefined {
    const at = text.lastIndexOf(MARK)
    if (at < 0) return undefined
    const parsed = Move.safeParse(JSON.parse(text.slice(at + MARK.length)))
    return parsed.success ? parsed.data : undefined
}

export const dollars = (cents: number) => (cents / 100).toFixed(0)
