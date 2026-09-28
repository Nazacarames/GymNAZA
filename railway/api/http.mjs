#!/usr/bin/env node
/* GymNAZA — el servidor MCP oficial de openGym, pero por HTTP en lugar de stdio, para poder
   agregarlo como "conector personalizado" en Claude (web y app del celular).

   - Reutiliza tal cual las herramientas de lectura de mcp/src/tools.js y suma las de escritura
     de write-tools.mjs (siempre con vista previa, confirmación y backup).
   - Modo sin sesión: cada petición crea su servidor y transporte, y se descartan al terminar.
   - Única protección: la ruta tiene que ser exactamente /mcp/<MCP_SECRET>. Cualquier otra → 404.
     La ruta nunca se escribe en los logs. */
import http from 'node:http'
import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { TOOLS } from './src/tools.js'
import { WRITE_TOOLS } from './write-tools.mjs'
import { init, getUser } from './src/state.js'

const PORT = +(process.env.MCP_PORT || 8081)
const SECRET = (process.env.MCP_SECRET || '').trim()
const log = (...a) => console.error('[opengym-mcp-http]', ...a)

if (SECRET.length < 32) {
  // Sin una clave larga no se sirve nada. Queda dormido para que el script de arranque no lo
  // reinicie en bucle; la API sigue funcionando igual.
  log('MCP_SECRET falta o tiene menos de 32 caracteres: conector desactivado')
  setInterval(() => {}, 1 << 30)
} else {
  const expected = Buffer.from('/mcp/' + SECRET)
  const pathOk = (url) => {
    const p = Buffer.from((url || '').split('?')[0].replace(/\/+$/, ''))
    return p.length === expected.length && crypto.timingSafeEqual(p, expected)
  }

  const buildServer = () => {
    const server = new McpServer({ name: 'opengym', version: '0.1.0' })
    // Las 9 de lectura oficiales + las de escritura de GymNAZA (write-tools.mjs).
    for (const t of [...TOOLS, ...WRITE_TOOLS]) {
      server.tool(t.name, t.description, t.schema, async (params) => {
        try {
          const result = await t.handler(params || {})
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `${err.code || 'ERROR'}: ${err.message}` }] }
        }
      })
    }
    return server
  }

  try {
    init()
    const u = getUser()
    log(`perfil servido: ${u.name} (${u.id})`)
  } catch (e) {
    // Igual que el MCP oficial: no salir, las herramientas responden el error hasta que haya datos.
    log(e.message)
  }

  http.createServer(async (req, res) => {
    if (!pathOk(req.url)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
      return
    }
    if (req.method !== 'POST') {
      // Sin sesiones no hay flujo GET/SSE ni DELETE que atender.
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }))
      return
    }
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      log('error atendiendo una petición:', e.message)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }))
      }
    }
  }).listen(PORT, () => log(`escuchando en :${PORT} (ruta /mcp/<secreto>)`))
}
