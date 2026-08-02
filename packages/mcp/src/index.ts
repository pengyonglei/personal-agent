import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolRegistry } from '@personal-agent/tool';
import { BaseTool } from '@personal-agent/tool';
import { createLogger } from '@personal-agent/shared';
import type { JSONSchema, ToolResult, ToolContext } from '@personal-agent/shared';

const log = createLogger('mcp');

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  autoApprove?: string[];
}

interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
}

interface MCPConnection {
  config: MCPServerConfig;
  client: Client;
  transport: Transport;
  connected: boolean;
  tools: MCPToolInfo[];
}

class MCPToolWrapper extends BaseTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly category = 'mcp' as const;
  readonly requiresPermission: boolean;
  readonly isDangerous: boolean;
  readonly canBeUsedInSubAgent = false;
  private readonly remoteToolName: string;

  constructor(
    serverName: string,
    tool: MCPToolInfo,
    autoApprove: string[],
    private readonly callFn: (
      toolName: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<ToolResult>,
  ) {
    super();
    this.name = `mcp__${serverName}__${tool.name}`;
    this.remoteToolName = tool.name;
    this.description = tool.description ?? `MCP tool: ${tool.name} (from ${serverName})`;
    this.inputSchema = tool.inputSchema;
    const approved = autoApprove.includes('*') || autoApprove.includes(tool.name);
    this.requiresPermission = !approved;
    this.isDangerous = !approved;
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.callFn(this.remoteToolName, params, context.signal);
  }
}

export function createMCPTransport(config: MCPServerConfig): Transport {
  if (config.transport === 'stdio') {
    if (!config.command) throw new Error(`MCP server '${config.name}' requires a command`);
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd,
      env: mergeEnvironment(config.env),
      stderr: 'pipe',
    });
  }

  if (!config.url) throw new Error(`MCP server '${config.name}' requires a url`);
  const requestInit = config.headers ? { headers: config.headers } : undefined;
  if (config.transport === 'sse') {
    return new SSEClientTransport(new URL(config.url), { requestInit });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
}

export class MCPClientManager {
  private connections = new Map<string, MCPConnection>();
  private transportFactory: (config: MCPServerConfig) => Transport;

  constructor(
    private registry: ToolRegistry | null = null,
    options: { transportFactory?: (config: MCPServerConfig) => Transport } = {},
  ) {
    this.transportFactory = options.transportFactory ?? createMCPTransport;
  }

  setToolRegistry(registry: ToolRegistry): void {
    this.registry = registry;
  }

  async connect(config: MCPServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      throw new Error(`MCP server '${config.name}' is already connected`);
    }

    const transport = this.transportFactory(config);
    const client = new Client(
      { name: 'personal-agent', version: '0.1.0' },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (error) => {
              if (error) {
                log.warn(`MCP ${config.name} tool refresh failed: ${error.message}`);
                return;
              }
              void this.refreshTools(config.name);
            },
          },
        },
      },
    );
    const connection: MCPConnection = {
      config,
      client,
      transport,
      connected: false,
      tools: [],
    };
    this.connections.set(config.name, connection);

    try {
      log.info(`Connecting to MCP server: ${config.name} (${config.transport})`);
      if (transport instanceof StdioClientTransport) {
        transport.stderr?.on('data', (data) => {
          log.debug(`[MCP ${config.name} stderr] ${String(data).trim()}`);
        });
      }
      await client.connect(transport);
      connection.connected = true;
      await this.refreshTools(config.name);
      log.info(`Connected to MCP server: ${config.name} (${connection.tools.length} tools)`);
    } catch (error) {
      this.connections.delete(config.name);
      try {
        await transport.close();
      } catch {
        // Ignore cleanup errors after a failed connection.
      }
      throw new Error(
        `Failed to connect to MCP '${config.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async refreshTools(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection?.connected) return;

    const discovered: MCPToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const result = await connection.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of result.tools) {
        discovered.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as JSONSchema,
        });
      }
      cursor = result.nextCursor;
    } while (cursor);

    if (this.registry) {
      for (const tool of connection.tools) {
        this.registry.unregister(`mcp__${serverName}__${tool.name}`);
      }
      for (const tool of discovered) {
        this.registry.registerMCP(
          new MCPToolWrapper(
            serverName,
            tool,
            connection.config.autoApprove ?? [],
            (toolName, args, signal) => this.callTool(serverName, toolName, args, signal),
          ),
        );
      }
    }
    connection.tools = discovered;
  }

  async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;

    if (this.registry) {
      for (const tool of connection.tools) {
        this.registry.unregister(`mcp__${name}__${tool.name}`);
      }
    }
    connection.connected = false;
    this.connections.delete(name);
    await connection.client.close();
    log.info(`Disconnected MCP server: ${name}`);
  }

  async disconnectAll(): Promise<void> {
    for (const name of [...this.connections.keys()]) {
      await this.disconnect(name);
    }
  }

  getConnection(name: string): { connected: boolean; toolCount: number } | undefined {
    const connection = this.connections.get(name);
    return connection
      ? { connected: connection.connected, toolCount: connection.tools.length }
      : undefined;
  }

  listServers(): Array<{ name: string; connected: boolean; toolCount: number }> {
    return [...this.connections.entries()].map(([name, connection]) => ({
      name,
      connected: connection.connected,
      toolCount: connection.tools.length,
    }));
  }

  private async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const connection = this.connections.get(serverName);
    if (!connection?.connected) {
      return {
        success: false,
        content: '',
        error: `MCP server '${serverName}' is not connected`,
      };
    }

    try {
      const result = await connection.client.callTool(
        {
          name: toolName,
          arguments: args,
        },
        undefined,
        signal ? { signal } : undefined,
      );
      const blocks = Array.isArray(result.content) ? result.content : [];
      const content = blocks.map(formatMCPContent).filter(Boolean).join('\n');
      return {
        success: result.isError !== true,
        content,
        error: result.isError === true ? content || 'MCP tool returned an error' : undefined,
      };
    } catch (error) {
      const interrupted = signal?.aborted === true;
      return {
        success: false,
        content: '',
        error: interrupted
          ? 'MCP tool execution interrupted by user'
          : `MCP tool error: ${error instanceof Error ? error.message : String(error)}`,
        metadata: interrupted ? { duration: 0, interrupted: true } : undefined,
      };
    }
  }
}

function mergeEnvironment(extra: Record<string, string> | undefined): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  return { ...inherited, ...(extra ?? {}) };
}

function formatMCPContent(content: unknown): string {
  if (!content || typeof content !== 'object') return String(content ?? '');
  const block = content as Record<string, unknown>;
  if (block.type === 'text') return String(block.text ?? '');
  if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
    const resource = block.resource as Record<string, unknown>;
    if (typeof resource.text === 'string') return resource.text;
    return JSON.stringify(resource);
  }
  if (block.type === 'image' || block.type === 'audio') {
    return `[${String(block.type)} content: ${String(block.mimeType ?? 'unknown type')}]`;
  }
  return JSON.stringify(block);
}
