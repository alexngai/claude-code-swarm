/**
 * map-connection.mjs — MAP SDK connection wrapper for claude-code-swarm
 *
 * Handles connecting to the MAP server, with fire-and-forget fallbacks
 * for when the sidecar is unavailable.
 */

import { resolveScope, resolveTeamName, resolveMapServer, DEFAULTS } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { resolvePackage } from "./swarmkit-resolver.mjs";

const log = createLogger("map");

/**
 * Connect to a MAP server as an agent.
 * Returns the AgentConnection or null on failure. Never throws.
 */
/**
 * Connect to a MAP server as an agent.
 *
 * @param credential  Opaque credential for server-driven auth negotiation.
 *   When the server requires auth (verified mode), uses the SDK's connectOnly()
 *   + authenticate() + register() flow. The client responds to the server's
 *   authRequired challenge with the server's preferred method + this credential.
 *   When absent, uses the standard SDK connect() for open mode servers.
 */
export async function connectToMAP({ server, scope, systemId, onMessage, credential }) {
  try {
    const mapSdk = await resolvePackage("@multi-agent-protocol/sdk");
    if (!mapSdk) throw new Error("@multi-agent-protocol/sdk not available");
    const { AgentConnection } = mapSdk;

    const teamName = scope.replace("swarm:", "");
    const agentName = `${teamName}-sidecar`;

    const connectOpts = {
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
    };

    let connection;

    if (credential && typeof AgentConnection.createConnection === "function") {
      // Verified mode: use the split flow (connectOnly → authenticate → register).
      // The server drives the auth method — we just respond with our credential.
      connection = await AgentConnection.createConnection(server, connectOpts);
      const connectResult = await connection.connectOnly();

      if (connectResult.authRequired && connectResult.authRequired.required) {
        const method = connectResult.authRequired.methods[0];
        const authResult = await connection.authenticate({ method, token: credential });
        if (!authResult.success) {
          log.error("authentication failed", { error: authResult.error?.message || "unknown error" });
          return null;
        }
      }

      await connection.register();
    } else {
      // Open mode (or SDK without createConnection): standard connect + register
      connection = await AgentConnection.connect(server, connectOpts);
    }

    if (onMessage) {
      connection.onMessage(onMessage);
    }

    log.info("connected", { server, agent: agentName, scope });
    return connection;
  } catch (err) {
    log.error("failed to connect to MAP server", { error: err.message });
    return null;
  }
}

/**
 * Fire-and-forget: send a single event directly to MAP server.
 * Creates an ephemeral connection, sends, disconnects. Silent on failure.
 */
export async function fireAndForget(config, event) {
  try {
    const mapSdk = await resolvePackage("@multi-agent-protocol/sdk");
    if (!mapSdk) throw new Error("@multi-agent-protocol/sdk not available");
    const { AgentConnection } = mapSdk;
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
    const mapSdk = await resolvePackage("@multi-agent-protocol/sdk");
    if (!mapSdk) throw new Error("@multi-agent-protocol/sdk not available");
    const { AgentConnection } = mapSdk;
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
