import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '@personal-agent/tool';
import { MCPClientManager, createMCPTransport } from '../src/index';

test('transport factory supports stdio, SSE, and Streamable HTTP', async () => {
  const stdio = createMCPTransport({
    name: 'stdio',
    transport: 'stdio',
    command: process.execPath,
  });
  const sse = createMCPTransport({
    name: 'sse',
    transport: 'sse',
    url: 'http://localhost:3000/sse',
  });
  const http = createMCPTransport({
    name: 'http',
    transport: 'streamable-http',
    url: 'http://localhost:3000/mcp',
  });
  assert.equal(stdio.constructor.name, 'StdioClientTransport');
  assert.equal(sse.constructor.name, 'SSEClientTransport');
  assert.equal(http.constructor.name, 'StreamableHTTPClientTransport');
  await stdio.close();
  await sse.close();
  await http.close();
});

test('manager discovers, invokes, refreshes, and unregisters MCP tools', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  let toolName = 'echo';
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: toolName,
        description: 'Echo text',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: `echo:${String(request.params.arguments?.text)}` }],
  }));
  await server.connect(serverTransport);

  const registry = new ToolRegistry();
  const manager = new MCPClientManager(registry, {
    transportFactory: () => clientTransport,
  });
  await manager.connect({
    name: 'local',
    transport: 'stdio',
    command: 'unused',
    autoApprove: ['*'],
  });

  const tool = registry.get('mcp__local__echo');
  assert.ok(tool);
  const result = await tool.execute(
    { text: 'hello' },
    { sessionId: 'test', workingDirectory: process.cwd() },
  );
  assert.equal(result.success, true);
  assert.equal(result.content, 'echo:hello');

  toolName = 'renamed';
  await manager.refreshTools('local');
  assert.equal(registry.get('mcp__local__echo'), undefined);
  assert.ok(registry.get('mcp__local__renamed'));

  await manager.disconnectAll();
  assert.equal(registry.get('mcp__local__renamed'), undefined);
  await server.close();
});
