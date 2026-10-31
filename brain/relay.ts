import { AgentRelay, type RelayAgentClient } from "@agent-relay/sdk"
import { actors } from "../market/client/generated/index.js"

export const relay = new AgentRelay({ workspaceKey: process.env.RELAY_WORKSPACE_KEY!, baseUrl: process.env.RELAY_BASE_URL })

const agents = new Map<string, RelayAgentClient>()

// Reconnects with the token stored in the User actor, so agents survive a brain restart.
export async function agentFor(userId: string): Promise<RelayAgentClient> {
    const known = agents.get(userId)
    if (known) return known
    const user = actors.User.get(userId)
    const { agentName, relayToken } = await user.profile()
    const agent = relayToken
        ? await relay.workspace.reconnect({ apiToken: relayToken })
        : await relay.workspace.register({ name: agentName, type: "agent" })
    if (!relayToken) await user.setRelayToken(agent.token!)
    agents.set(userId, agent)
    return agent
}
