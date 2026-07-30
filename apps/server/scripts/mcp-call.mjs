#!/usr/bin/env node
// mcp-call — one-shot MCP client for Learn Shell.
//
// The agent's hand when the interactive session can't hot-load the MCP
// server. Speaks the real protocol (initialize → tools/call | resources/read),
// so every write goes through the exact interface any external agent uses.
//
// Local by default: spawns this repo's own MCP server (src/mcp/server.ts) via
// tsx, resolved relative to this script's own location — clone anywhere, run
// from anywhere, no assumed host or path.
//
// Set SSH_TARGET to route over `ssh -T <target>` instead (e.g. driving a
// remote instance from a dev machine). SSH_REMOTE_DIR overrides the remote
// repo root used in that mode (default: ~/learn-shell).
//
// Usage:
//   node scripts/mcp-call.mjs tools                          # list tools
//   node scripts/mcp-call.mjs call <tool> '<json-args>'      # call a tool
//   node scripts/mcp-call.mjs read <resource-uri>            # read a resource
//   node scripts/mcp-call.mjs prompt <prompt-name>           # get a prompt
//
// Env:
//   SSH_TARGET     — if set, run the MCP server over ssh instead of spawning
//                     it locally.
//   SSH_REMOTE_DIR — remote repo root when SSH_TARGET is set (default: ~/learn-shell).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [, , cmd, a1, a2] = process.argv;

const SSH_TARGET = process.env.SSH_TARGET;

let transport;
if (SSH_TARGET) {
  const remoteDir = process.env.SSH_REMOTE_DIR || '~/learn-shell';
  transport = new StdioClientTransport({
    command: 'ssh',
    args: [
      '-T',
      SSH_TARGET,
      `cd ${remoteDir}/apps/server && exec ./node_modules/.bin/tsx src/mcp/server.ts`,
    ],
  });
} else {
  // apps/server/scripts/mcp-call.mjs -> apps/server (the server package root)
  const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp/server.ts'],
    cwd: serverDir,
    env: { ...process.env },
  });
}

const client = new Client({ name: 'ls-mcp-cli', version: '1.0.0' });
await client.connect(transport);

try {
  if (cmd === 'tools') {
    const { tools } = await client.listTools();
    console.log(tools.map((t) => t.name).join('\n'));
  } else if (cmd === 'call') {
    const res = await client.callTool({ name: a1, arguments: a2 ? JSON.parse(a2) : {} });
    for (const c of res.content ?? []) {
      console.log(c.type === 'text' ? c.text : JSON.stringify(c));
    }
    if (res.isError) process.exitCode = 1;
  } else if (cmd === 'read') {
    const res = await client.readResource({ uri: a1 });
    for (const c of res.contents ?? []) console.log(c.text ?? '');
  } else if (cmd === 'prompt') {
    const res = await client.getPrompt({ name: a1 });
    for (const m of res.messages ?? []) {
      console.log(typeof m.content === 'object' && 'text' in m.content ? m.content.text : '');
    }
  } else {
    console.error('usage: mcp-call.mjs tools | call <tool> <json> | read <uri> | prompt <name>');
    process.exitCode = 1;
  }
} finally {
  await client.close();
}
