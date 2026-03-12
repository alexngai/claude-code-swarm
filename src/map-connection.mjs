/**
 * map-connection.mjs — MAP SDK connection wrapper for claude-code-swarm
 *
 * Handles connecting to the MAP server, with fire-and-forget fallbacks
 * for when the sidecar is unavailable.
 */

import { resolveScope, resolveTeamName, resolveMapServer, DEFAULTS } from "./config.mjs";

/**
 * Connect to a MAP server as an agent.
 * Returns the AgentConnection or null on failure. Never throws.
 */
export async function connectToMAP({ server, scope, systemId, onMessage }) {
  try {
    const { AgentConnection } = await import("@multi-agent-protocol/sdk");

    const teamName = scope.replace("swarm:", "");
    const agentName = `${teamName}-sidecar`;

    const connection = await AgentConnection.connect(server, {
      name: agentName,
      role: "sidecar",
      scopes: [scope],
      capabilities: {
        trajectory: { canReport: true },
        tasks: { canCreate: true, canAssign: true, canUpdate: true, canList: true },
      },
      metadata: {
        systemId,
        type: "claude-code-swarm-sidecar",
      },
      reconnection: {
        enabled: true,
        maxRetries: 10,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      },
    });

    if (onMessage) {
      connection.onMessage(onMessage);
    }

    process.stderr.write(
      `[map] Connected to ${server} as ${agentName} in scope ${scope}\n`
    );
    return connection;
  } catch (err) {
    process.stderr.write(
      `[map] Failed to connect to MAP server: ${err.message}\n`
    );
    return null;
  }
}

/**
 * Fire-and-forget: send a single event directly to MAP server.
 * Creates an ephemeral connection, sends, disconnects. Silent on failure.
 */
export async function fireAndForget(config, event) {
  try {
    const { AgentConnection } = await import("@multi-agent-protocol/sdk");
    const server = resolveMapServer(config);
    const scope = resolveScope(config);
    const teamName = resolveTeamName(config);

    const agent = await AgentConnection.connect(server, {
      name: `${teamName}-hook`,
      role: "hook",
      scopes: [scope],
    });

    await agent.send({ scope }, event);
    await agent.disconnect();
  } catch {
    // Silently drop — never block the agent
  }
}

/**
 * Fire-and-forget: report a trajectory checkpoint directly to MAP server.
 * Falls back to broadcast event if server doesn't support trajectory.
 */
export async function fireAndForgetTrajectory(config, checkpoint) {
  try {
    const { AgentConnection } = await import("@multi-agent-protocol/sdk");
    const server = resolveMapServer(config);
    const scope = resolveScope(config);
    const teamName = resolveTeamName(config);

    const agent = await AgentConnection.connect(server, {
      name: `${teamName}-hook`,
      role: "hook",
      scopes: [scope],
      capabilities: { trajectory: { canReport: true } },
    });

    try {
      await agent.callExtension("trajectory/checkpoint", { checkpoint });
    } catch {
      // Server doesn't support trajectory — fall back to broadcast as message
      await agent.send(
        { scope },
        {
          type: "trajectory.checkpoint",
          checkpoint: {
            id: checkpoint.id,
            agentId: checkpoint.agentId,
            sessionId: checkpoint.sessionId,
            label: checkpoint.label,
            metadata: checkpoint.metadata,
          },
        }
      );
    }

    await agent.disconnect();
  } catch {
    // Silently drop — never block the agent
  }
}
