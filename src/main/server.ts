import { createServer, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import type { AddressInfo } from 'node:net'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Serve the built renderer over http://127.0.0.1 instead of loading it from
 * `file://`.
 *
 * This is not cosmetic. A `file://` page has no HTTP origin, and the YouTube
 * IFrame player rejects playback with error 153 when it cannot validate one -
 * so the music player simply never plays from a file:// build. Dev mode already
 * runs on http://localhost, which is why it behaves differently there.
 *
 * Bound to the loopback interface on an OS-assigned port, so nothing is
 * reachable off the machine.
 */
export async function serveRenderer(root: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    const rel = normalize(rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, ''))
    // normalize() collapses `..`; anything still trying to escape is rejected.
    if (rel.startsWith('..')) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const file = join(root, rel)
    void stat(file)
      .then((s) => {
        if (!s.isFile()) throw new Error('not a file')
        res.writeHead(200, {
          'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Content-Length': String(s.size),
          'Cache-Control': 'no-cache',
        })
        createReadStream(file).pipe(res)
      })
      .catch(() => {
        res.writeHead(404).end('Not found')
      })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/index.html`, server }
}
