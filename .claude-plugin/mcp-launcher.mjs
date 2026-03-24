#!/usr/bin/env node
/**
 * Unified MCP server launcher for claude-code-swarm plugin.
 *
 * Usage: node mcp-launcher.mjs <server>
 *   server: opentasks | minimem | agent-inbox
 *
 * Reads .swarm/claude-swarm/config.json once, checks enablement,
 * resolves CLI args, and exec's the real server or falls back to noop.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const server = process.argv[2];

if (!server) {
  process.stderr.write('Usage: mcp-launcher.mjs <opentasks|minimem|agent-inbox>\n');
  process.exit(1);
}

// --- Config ---

function readConfig() {
  const configPath = '.swarm/claude-swarm/config.json';
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function envBool(key) {
  const v = (process.env[key] || '').toLowerCase();
  return ['true', '1', 'yes'].includes(v);
}

function env(key) {
  return process.env[key] || '';
}

const config = readConfig();

// --- Noop ---

function runNoop() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    if (msg.method === 'initialize') {
      respond({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'noop-mcp', version: '1.0.0' } });
    } else if (msg.method === 'tools/list') {
      respond({ tools: [] });
    } else if (msg.method === 'resources/list') {
      respond({ resources: [] });
    } else if (msg.method === 'prompts/list') {
      respond({ prompts: [] });
    } else if (msg.id !== undefined && !msg.method?.startsWith('notifications/')) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
    }
  });
  rl.on('close', () => process.exit(0));
}

// --- CLI resolution ---

function which(cmd) {
  try {
    return execFileSync('which', [cmd], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function findSocket(paths) {
  for (const p of paths) {
    try {
      if (existsSync(p) && statSync(p).isSocket?.()) return p;
    } catch {}
  }
  return null;
}

// --- Server definitions ---

const servers = {
  opentasks: {
    enabled: () => envBool('SWARM_OPENTASKS_ENABLED') || config.opentasks?.enabled === true,
    launch: () => {
      const scope = env('SWARM_OPENTASKS_SCOPE') || config.opentasks?.scope || 'tasks';
      const socket = findSocket([
        '.swarm/opentasks/daemon.sock',
        '.opentasks/daemon.sock',
        '.git/opentasks/daemon.sock',
      ]);
      const args = ['mcp', '--scope', scope];
      if (socket) args.push('--socket', socket);
      return { cmd: 'opentasks', args };
    },
  },

  minimem: {
    enabled: () => envBool('SWARM_MINIMEM_ENABLED') || config.minimem?.enabled === true,
    launch: () => {
      const provider = env('SWARM_MINIMEM_PROVIDER') || config.minimem?.provider || 'auto';
      let dir = env('SWARM_MINIMEM_DIR') || config.minimem?.dir || '';
      if (!dir) {
        dir = existsSync('.swarm/minimem') ? '.swarm/minimem' : '.';
      }
      const useGlobal = envBool('SWARM_MINIMEM_GLOBAL') || config.minimem?.global === true;
      const args = ['mcp', '--dir', dir, '--provider', provider];
      if (useGlobal) args.push('--global');
      return { cmd: 'minimem', args };
    },
  },

  'agent-inbox': {
    enabled: () => envBool('SWARM_INBOX_ENABLED') || config.inbox?.enabled === true,
    launch: () => {
      const scope = env('SWARM_INBOX_SCOPE') || config.inbox?.scope || config.map?.scope || 'default';
      process.env.INBOX_SCOPE = scope;

      // Discover sidecar inbox socket for proxy mode
      let inboxSock = findSocket(['.swarm/claude-swarm/tmp/map/inbox.sock']);
      if (!inboxSock) {
        const sessDir = '.swarm/claude-swarm/tmp/map/sessions';
        try {
          if (existsSync(sessDir)) {
            for (const d of readdirSync(sessDir)) {
              const sock = join(sessDir, d, 'inbox.sock');
              if (existsSync(sock)) { inboxSock = sock; break; }
            }
          }
        } catch {}
      }
      if (inboxSock) {
        process.env.INBOX_SOCKET_PATH = inboxSock;
      }

      return { cmd: 'agent-inbox', args: ['mcp'] };
    },
  },
};

// --- Main ---

const def = servers[server];
if (!def) {
  process.stderr.write(`Unknown server: ${server}\n`);
  process.exit(1);
}

if (!def.enabled()) {
  runNoop();
} else {
  const { cmd, args } = def.launch();
  if (which(cmd)) {
    // Replace this process with the real server
    const { execFileSync: _ , ...rest } = await import('node:child_process');
    const child = (await import('node:child_process')).spawn(cmd, args, {
      stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  } else {
    process.stderr.write(`[${server}-mcp] ${cmd} CLI not found\n`);
    runNoop();
  }
}
