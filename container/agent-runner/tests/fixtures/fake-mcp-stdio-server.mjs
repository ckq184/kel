/**
 * Minimal MCP stdio server for tests: newline-delimited JSON-RPC 2.0.
 * Implements just enough of the MCP protocol (initialize, tools/list,
 * tools/call) for Pi's built-in MCP client to connect and discover one
 * `echo` tool. No dependencies.
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg ?? {};
  if (method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo a value back as text',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          },
        ],
      },
    });
  } else if (method === 'tools/call') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          { type: 'text', text: `echo:${params?.arguments?.value ?? ''}` },
        ],
      },
    });
  } else if (id !== undefined) {
    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `unknown method ${method}` },
    });
  }
});
