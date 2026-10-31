// End-to-end evals against a running stack: Relay engine :8787, `terse actor dev` :7100, brain :3000.
// Run from the repo root:  bun scripts/eval.ts [--runs 3] [--restart]
// --restart also kill -9s the brain mid-haggle and restarts it (it keeps running afterwards, logging to /tmp/brain-eval.log).
const BASE = process.env.EVAL_URL ?? "http://localhost:3000"
const args = process.argv.slice(2)
const RUNS = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 3
const uniq = Date.now().toString(36)
const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail })
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`)
}

type Order = { id: string; listingId: string; buyerId: string; sellerId: string; status: string; moves: { from: string }[]; finalCents?: number; escrow: string; closedReason?: string; reveal?: { floorCents?: number; ceilingCents?: number } }
type State = { listings: { id: string; status: string; askCents: number }[]; orders: Order[]; users: { id: string; escrowCents: number; heldCents?: number; activity: { orderId?: string; kind: string; text: string }[] }[] }

async function post(path: string, body: unknown = {}) {
    const res = await fetch(`${BASE}/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    return { ok: res.ok, data: (await res.json()) as Record<string, any> }
}
const state = async (): Promise<State> => (await fetch(`${BASE}/api/state`)).json()
const user = (s: State, id: string) => s.users.find((u) => u.id === id)
const order = (s: State, id: string) => s.orders.find((o) => o.id === id)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const $ = (cents = 0) => `$${Math.round(cents / 100)}`

async function waitClosed(orderId: string, timeoutMs = 150_000): Promise<Order | undefined> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
        const o = order(await state(), orderId)
        if (o && o.status !== "open") return o
        await sleep(1500)
    }
    return order(await state(), orderId)
}
async function join(name: string) {
    return (await post("join", { name: `${name} ${uniq}` })).data.id as string
}
async function list(sellerId: string, title: string, ask: number, floor: number) {
    return (await post("sell", { userId: sellerId, title: `${title} ${uniq}`, askDollars: ask, floorDollars: floor, condition: "Good" })).data.id as string
}
// Any amount next to the words floor/ceiling/limit in public text is a leak while the order is live.
const leaks = (text: string) => /(floor|ceiling|limit|max|min)/i.test(text) && /\$\d/.test(text) && !text.includes("🔒")

// 1. Health
{
    const s = await state().catch(() => undefined)
    check("health", !!s && s.listings.length >= 12 && s.users.length >= 5, s ? `${s.listings.length} listings, ${s.users.length} users` : "brain not reachable")
    if (!s) process.exit(1)
}

// 2 + 3. Win-win demo, money moves exactly once, limits sealed while live
async function demoRuns() {
    for (let i = 1; i <= RUNS; i++) {
        const { data } = await post("demo")
        const id = data.orderId as string
        const s0 = await state()
        const [b0, s0e] = [user(s0, "pumpkin")!.escrowCents, user(s0, "ghosty")!.escrowCents]
        let leaked = 0
        for (let k = 0; k < 4; k++) {
            await sleep(2000)
            const live = await state()
            if (order(live, id)?.status !== "open") break
            leaked += live.users.flatMap((u) => u.activity).filter((a) => a.orderId === id && leaks(a.text)).length
        }
        const o = await waitClosed(id)
        const s1 = await state()
        const r = o?.reveal ?? {}
        const final = o?.finalCents ?? 0
        const inZone = !!r.floorCents && !!r.ceilingCents && final >= r.floorCents && final <= r.ceilingCents
        check(`demo ${i}: deal`, o?.status === "deal" && (o?.moves.length ?? 99) <= 11, `${o?.status} in ${o?.moves.length} moves at ${$(final)}`)
        check(`demo ${i}: win-win`, inZone && final < r.ceilingCents! && final > r.floorCents!, `buyer ${$(r.ceilingCents! - final)} under max, seller ${$(final - r.floorCents!)} over floor`)
        // Reconcile against every pumpkin->ghosty deal that settled in this window (a resumed order can settle alongside).
        const settled = (s: State) => s.orders.filter((x) => x.buyerId === "pumpkin" && x.sellerId === "ghosty" && x.escrow === "released")
        const before = new Set(settled(s0).map((x) => x.id))
        const fresh = settled(s1).filter((x) => !before.has(x.id))
        const expected = fresh.reduce((n, x) => n + (x.finalCents ?? 0), 0)
        const bd = b0 - user(s1, "pumpkin")!.escrowCents, sd = user(s1, "ghosty")!.escrowCents - s0e
        check(`demo ${i}: money once`, fresh.some((x) => x.id === id) && bd === expected && sd === expected, `buyer -${$(bd)}, seller +${$(sd)} = ${fresh.length} deal(s) settled in window (${fresh.map((x) => $(x.finalCents)).join(" + ")})`)
        check(`demo ${i}: sealed while live`, leaked === 0, `${leaked} leaking public entries seen mid-haggle`)
    }
}

// 4 + 5. Hopeless lowball ends by the cap and returns the hold; one try per item
async function lowball() {
    const buyer = await join("Eval Lowballer")
    const target = (await state()).listings.find((l) => l.status === "open")!
    const { data } = await post("buy", { userId: buyer, listingId: target.id, ceilingDollars: 1 })
    const again = await post("buy", { userId: buyer, listingId: target.id, ceilingDollars: 500 })
    check("one try per item", !again.ok && /one try/.test(again.data.error ?? ""), again.data.error ?? "second try was accepted")
    const o = await waitClosed(data.orderId)
    const u = user(await state(), buyer)!
    check("no-overlap terminates", o?.status === "walked" && o.moves.length <= 11, `${o?.status} after ${o?.moves.length} moves`)
    check("walk returns hold", (u.heldCents ?? 0) === 0 && u.escrowCents === 200000, `escrow ${$(u.escrowCents)}, held ${$(u.heldCents)}`)
}

// 6. Two buyers race for one item: at most one deal, loser untouched, seller paid once
async function race() {
    const seller = await join("Eval Seller")
    const item = await list(seller, "Race Gadget", 300, 230)
    const [a, b] = [await join("Eval Racer A"), await join("Eval Racer B")]
    const opened = await Promise.all([a, b].map((u) => post("buy", { userId: u, listingId: item, ceilingDollars: 300 })))
    const orders = await Promise.all(opened.filter((r) => r.ok).map((r) => waitClosed(r.data.orderId)))
    const s = await state()
    const deals = orders.filter((o) => o?.status === "deal")
    const paid = deals.reduce((n, o) => n + (o!.finalCents ?? 0), 0)
    const losers = orders.filter((o) => o?.status !== "deal").map((o) => user(s, o!.buyerId)!)
    check("race: one sale", deals.length <= 1, `${deals.length} deal(s): ${orders.map((o) => `${o?.status}${o?.closedReason ? ` (${o.closedReason})` : ""}`).join(", ")}`)
    check("race: loser untouched", losers.every((u) => u.escrowCents === 200000 && !u.heldCents), losers.map((u) => `${$(u.escrowCents)} held ${$(u.heldCents)}`).join(", ") || "no loser")
    check("race: seller paid once", user(s, seller)!.escrowCents - 200000 === paid, `seller +${$(user(s, seller)!.escrowCents - 200000)} vs deals ${$(paid)}`)
}

// 7. One balance can't back more ceilings than it covers
async function overcommit() {
    const seller = await join("Eval Seller 2")
    const [i1, i2, i3] = [await list(seller, "Big Gadget A", 900, 700), await list(seller, "Big Gadget B", 900, 700), await list(seller, "Small Gadget", 300, 230)]
    const buyer = await join("Eval Spender")
    const r1 = await post("buy", { userId: buyer, listingId: i1, ceilingDollars: 900 })
    const r2 = await post("buy", { userId: buyer, listingId: i2, ceilingDollars: 900 })
    const r3 = await post("buy", { userId: buyer, listingId: i3, ceilingDollars: 300 })
    check("overcommit refused", r1.ok && r2.ok && !r3.ok && /not enough escrow/.test(r3.data.error ?? ""), r3.data.error ?? "third order was accepted")
    const orders = await Promise.all([r1, r2].map((r) => waitClosed(r.data.orderId)))
    const u = user(await state(), buyer)!
    const spent = orders.reduce((n, o) => n + (o?.status === "deal" ? o.finalCents ?? 0 : 0), 0)
    check("holds reconcile", !u.heldCents && u.escrowCents === 200000 - spent, `escrow ${$(u.escrowCents)} = $2000 - ${$(spent)}, held ${$(u.heldCents)}`)
}

// 8. Injection attack with a hijacked seller LLM: guard blocks, nothing sells, hold returns
async function attack() {
    const { data } = await post("attack")
    const o = await waitClosed(data.orderId)
    const s = await state()
    const blocked = s.users.flatMap((u) => u.activity).filter((a) => a.orderId === data.orderId && a.kind === "blocked").length
    check("hack: no sale", o?.status === "walked" && !o.finalCents, `${o?.status} after ${o?.moves.length} moves`)
    check("hack: guard fired", blocked >= 1, `${blocked} hijacked moves blocked`)
    check("hack: hold returned", !user(s, "hacker")!.heldCents, `hacker held ${$(user(s, "hacker")!.heldCents)}`)
}

// Stale identity (a browser that kept a user id across a reset): must be refused, not crash the brain
async function staleIdentity() {
    const target = (await state()).listings.find((l) => l.status === "open")!
    const r = await post("buy", { userId: `ghost-${uniq}`, listingId: target.id, ceilingDollars: 100 })
    check("unknown user refused", !r.ok && /unknown user/.test(r.data.error ?? ""), r.data.error ?? "an order opened for a user who never joined")
}

// 9. Actor-level concurrency checks
async function actors() {
    const p = Bun.spawn(["bun", "scripts/race-check.ts"], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    check("actor race-check", code === 0, out.trim().split("\n").filter((l) => l.startsWith("PASS")).length + "/7 actor checks passed")
}

// 10. kill -9 mid-haggle, restart, the order resumes and settles once
async function restart() {
    const { data } = await post("demo")
    for (let k = 0; k < 30; k++) { if ((order(await state(), data.orderId)?.moves.length ?? 0) >= 2) break; await sleep(1000) }
    // -sTCP:LISTEN: only the server. Plain `lsof -ti tcp:3000` also lists clients, including this script.
    const pid = (await new Response(Bun.spawn(["lsof", "-ti", "tcp:3000", "-sTCP:LISTEN"]).stdout).text()).trim()
    for (const p of pid.split("\n").filter(Boolean)) process.kill(Number(p), "SIGKILL")
    await sleep(1500)
    // nohup + background through sh: the restarted brain must outlive this script.
    Bun.spawn(["sh", "-c", "nohup bun brain/index.ts > /tmp/brain-eval.log 2>&1 &"]).unref()
    for (let k = 0; k < 30; k++) { if (await state().then(() => true, () => false)) break; await sleep(1000) }
    const o = await waitClosed(data.orderId)
    check("kill -9 and resume", o?.status === "deal" && o.escrow === "released", `${o?.status} after ${o?.moves.length} moves, escrow ${o?.escrow}`)
}

await Promise.all([demoRuns(), lowball(), race(), overcommit(), attack(), staleIdentity(), actors()])
if (args.includes("--restart")) await restart()
check("brain still up", await state().then(() => true, () => false), "API answers after every eval")

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} evals passed`)
for (const f of failed) console.log(`  FAILED ${f.name}: ${f.detail}`)
process.exit(failed.length ? 1 : 0)
