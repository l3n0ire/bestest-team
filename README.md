# bestest-team

> Haunted Haggle: your AI agent haggles for used gadgets so you don't have to. You set a secret limit; code, not the prompt, enforces it.

## Problem

Buying and selling used gadgets on Marketplace or Craigslist means lowballers, endless back-and-forth and haggling nobody enjoys.

## What it does

- List an item with a secret floor, or send your agent after a listing with a secret ceiling (plus optional deadline and preferences).
- Buyer and seller agents negotiate on their own over Agent Relay DMs (OFFER / COUNTER / ACCEPT / REJECT). No human approval step; every decision is explained in a live activity log.
- Limits are enforced in the seller's/buyer's Terse actor before any move is sent. The other side's agent can never read your limit. Kill the backend mid-haggle and it resumes from durable actor state. Payments are simulated escrow.

## Demo

<!-- Video / deployed app / screenshots -->

## Run locally

```bash
cp .env.example .env   # fill in keys
# 1. Relay engine (needs Node 22; it crashes on Node 26)
mise exec node@22 -- npx -y @relaycast/engine --db ./relay/relaycast.db --port 8787
#    create a workspace once and put its key in .env as RELAY_WORKSPACE_KEY:
curl -XPOST localhost:8787/v1/workspaces -H 'content-type: application/json' -d '{"name":"agent-market"}'
# 2. Terse actors (Bun >= 1.4.2)
cd market/actor && bun install && terse actor dev
# 3. Brain + UI on http://localhost:3000
cd brain && bun install && cd .. && bun brain/index.ts
```

## Tech stack

Terse durable actors (state, limits, orders) · Agent Relay / Relaycast (agent-to-agent messaging) · Bun brain process · OpenAI gpt-5.4-nano · plain HTML/CSS/JS UI

## Team

- [l3n0ire](https://github.com/l3n0ire)
- [Tony-beeper](https://github.com/Tony-beeper)
