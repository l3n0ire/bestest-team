# Agent Marketplace: build plan

Used gadgets. Each person's AI agent haggles with another person's agent over Agent Relay. Terse actors hold the state. Code, not the prompt, enforces every price limit.

**Trust story for judges:** the seller's floor lives only in the seller's `User` actor. Every move goes through `authorize()` inside that actor before anything is sent, and the buyer's agent cannot read it.

## File layout

```
bestest-team/
  actor/                 # Terse project (terse init)
    src/User.ts          # name, relay identity, private mandates, activity log, fake escrow
    src/Listing.ts       # public listing: title, condition, ask, status
    src/Order.ts         # one negotiation: moves, whose turn, outcome
  shared/
    protocol.ts          # zod Move schema + types (brain and web import it)
    rules.ts             # checkMove(): pure function, unit-tested
    rules.test.ts
  brain/                 # Bun process; the only thing that calls OpenAI and Relay
    index.ts             # boot: connect Relay, reconnect agents, resume open orders, listen
    relay.ts             # register/reconnect agents, sendMove(), parseMove()
    negotiate.ts         # OpenAI call -> proposed Move + reasoning
    loop.ts              # onMove(): apply, decide, authorize, send
    seed.ts              # 12 listings + bot sellers (+ skeleton costume)
  web/                   # UI: market scene, two characters, bubbles, ticker, activity log
  .env                   # OPENAI_API_KEY, RELAY_WORKSPACE_KEY, RELAY_BASE_URL (gitignored)
```

## Actors

```ts
// User: everything private stays here
@Persisted name: string
@Persisted agentName: string            // Relay identity, e.g. "agent-colin"
@Persisted relayToken: string           // for relay.workspace.reconnect() after a restart
@Persisted mandates: Record<string, Mandate>   // key: listingId. Never emitted.
@Persisted @Emittable activity: ActivityEntry[] // { at, orderId, kind, text }: decisions, blocked moves
@Persisted @Emittable escrowCents: number       // simulated balance
authorize(listingId, move, standing): Verdict   // runs checkMove() against its own mandate
publicProfile(): { name, agentName }            // the only read other parties get

// Listing: public
@Persisted @Emittable listing: { id, sellerId, title, condition, askCents, emoji, status: 'open'|'negotiating'|'sold' }

// Order: one buyer-seller negotiation
@Persisted @Emittable order: {
  id, listingId, buyerId, sellerId, dmId,
  moves: Move[],                 // full history for the ticker
  turn: string | null,           // userId who moves next; null when closed
  standing?: { priceCents, from },
  status: 'open'|'deal'|'walked'|'expired',
  finalCents?: number, escrow: 'none'|'held'|'released'
}
applyMove(move): { applied: boolean }   // idempotent on moveId; checks turn + state machine
```

```ts
type Mandate = { side: 'buy'|'sell'; limitCents: number; deadlineAt?: number; prefs?: string }
```

## Message schema (`shared/protocol.ts`)

```ts
const Base = z.object({
  v: z.literal(1), moveId: z.string().uuid(), orderId: z.string(), listingId: z.string(),
  from: z.string(), round: z.number().int(), text: z.string().max(200), sentAt: z.number(),
});
export const Move = z.discriminatedUnion('type', [
  Base.extend({ type: z.literal('OFFER'),   priceCents: z.number().int().positive() }), // buyer's opener
  Base.extend({ type: z.literal('COUNTER'), priceCents: z.number().int().positive() }),
  Base.extend({ type: z.literal('ACCEPT'),  priceCents: z.number().int().positive() }), // must equal standing
  Base.extend({ type: z.literal('REJECT') }),                                           // walk away
]);
```

On Relay, the message `text` is the human line ("$640 and I'll pick up tonight 🎃") and the JSON move goes in metadata. If the SDK has no metadata field, append `\n§{json}` to the text and parse the part after `§`. Listings are announced on `#listings`. Each negotiation is a DM between the two agents.

## Limit enforcement (`shared/rules.ts`)

```ts
export type Verdict = { ok: true } | { ok: false; reason: string };

export function checkMove(m: Mandate, move: Move, standing: Standing | undefined, self: string, now: number): Verdict {
  if (move.type === 'REJECT') return { ok: true };            // walking away is always allowed
  if (m.deadlineAt && now > m.deadlineAt) return no('deadline passed');
  const p = move.priceCents;
  if (m.side === 'sell' && p < m.limitCents) return no(`$${d(p)} is below your floor`);
  if (m.side === 'buy'  && p > m.limitCents) return no(`$${d(p)} is above your ceiling`);
  if (move.type === 'ACCEPT' && (!standing || standing.from === self || standing.priceCents !== p))
    return no('can only accept the other side\'s current offer');
  if (move.text.includes(d(m.limitCents))) return no('message would reveal your limit');
  return { ok: true };
}
```

`User.authorize()` is the only caller. When a move is blocked, the brain writes "Tried $480, blocked: below your floor" to the activity log and asks the LLM again once with the reason. If the second try is blocked too, it falls back to a fixed move: counter at the limit, or REJECT once 8 rounds have passed.

## Brain loop (`brain/loop.ts`)

1. A `message.created` event arrives for an agent the brain owns. Parse the Move, then call `Order.applyMove`, which ignores duplicates.
2. If `order.turn` belongs to one of our agents, call `negotiate()`. OpenAI returns JSON `{type, priceCents, text, reasoning}` and `reasoning` goes into the activity log.
3. Call `User.authorize()` and then `Order.applyMove()`. Only after both pass does `sendMove()` go over Relay.
4. On ACCEPT: `Order.status = 'deal'`, escrow is held, then released, and both `User.escrowCents` balances update.
5. On boot: reconnect every agent with its stored token. For each open order where it is one of our agents' turn, run step 2. This is the restart demo.

## Findings (1:15pm): GO on local Relay

- **Terse:** `terse init` needs a Terse login, but `terse actor dev` and `terse actor generate` work without one. We write our own `market/actor` (no template code). State survived a dev-server restart (hits 2 → 3).
- **Relaycast:** run it under Node 22. On Node 26 it exits silently because of the native sqlite addon. Start it with `mise exec node@22 -- npx -y @relaycast/engine --db ./relay/relaycast.db --port 8787`. The workspace key is saved in `.env` along with `RELAY_BASE_URL=http://localhost:8787`.
- **SDK on localhost:** works. `register()` → `sendMessage({to:'@b'})` → `addListener('dm.received')` fires within about 1s.
- **`metadata` is dropped from the received event.** Use the fallback: `text + "\n§" + JSON`. The UI strips everything after `§`.
- **The event has no recipient**, only `from` and `conversationId`. `Order.dmId = conversationId`, and the receiver is the other party on the Order. The brain owns every agent, so one listener sees all DMs.

## First 90 minutes (from 11:55)

| Time | Step | Done when |
|---|---|---|
| 11:55 | Install Bun ≥1.4.2 and `terse-cli`. Add `.gitignore` (`.env`, `*.db`, `.agentworkforce/`, `node_modules`) | `bun --version`, `terse --help` |
| 12:05 | `terse init actor --template counter`, `terse actor dev`, call it from a Bun script. **Kill and restart the dev server and check the counter survives.** | Value persists across restart |
| 12:15 | `npx @relaycast/engine --db ./relaycast.db --port 8787`. SDK with `baseUrl: http://localhost:8787`: register `agent-a` and `agent-b`, DM a→b, log the envelope. Check: is there a metadata field, which recipient shows up in the event, does reconnect-by-token work | b's listener logs a's message with recipient info |
| 12:40 | **Go/no-go on local Relay.** If it doesn't work, use the hosted workspace (a key already exists in `.agentworkforce/relay/`). Messaging through actors is the last resort | Decision written in this file |
| 12:45 | `shared/protocol.ts` + `rules.ts` + `bun test` (floor, ceiling, accept-mismatch, leak, deadline) | Tests green |
| 12:55 | Replace the counter with `User`, `Listing`, `Order`; `terse actor generate` | Generated client compiles |
| 1:00 | Lunch | |
| 1:10 | `brain/loop.ts` with a **fixed negotiator, no LLM** (split the difference each round). Two seeded agents haggle over Relay | A deal closes in the terminal, inside the limits |
| 1:25 | Next: swap in OpenAI, then seed data, then UI | |

**Cut if behind, in this order:** prefs, deadlines, the Halloween listing, phones joining through a tunnel, the escrow animation. Never cut: limit enforcement, the activity log, the restart demo.
