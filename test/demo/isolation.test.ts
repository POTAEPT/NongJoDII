import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LineHttpClient } from '@/server/line/client'

const ROOT = join(__dirname, '..', '..')

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  return [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? routeFiles(p) : name === 'route.ts' ? [p] : []
  })
}

describe('demo isolation from production', () => {
  it('getDeps (the production composition) imports no demo file', () => {
    const imports = importsOf(join(ROOT, 'src/server/deps.ts'))
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((i) => /demo/i.test(i))).toEqual([])
  })

  it('no /api route imports a demo file', () => {
    const files = routeFiles(join(ROOT, 'src/app/api'))
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) expect(importsOf(f).filter((i) => /demo/i.test(i)), f).toEqual([])
  })

  it('the production LINE client refuses a demo ID token (LINE answers 400)', async () => {
    const seen: string[] = []
    const line = new LineHttpClient({
      channelAccessToken: 't', loginChannelId: '123',
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        seen.push(String(init?.body))
        return new Response('{"error":"invalid_request"}', { status: 400 })
      }) as typeof fetch,
    })
    expect(await line.verifyIdToken('demo:Udemo0000000000000000000000000a01')).toBeNull()
    expect(seen).toHaveLength(1)
  })
})
