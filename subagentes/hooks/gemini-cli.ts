import type { EngineInterface } from 'claude-code'

import type { Run } from '../types'

// Gemini chamado direto pela linha de comando (`gemini -m … -p "…"`), sem o
// script/gemini-dev. O CLI grava cada execução em
// ~/.gemini/tmp/<projeto>/chats/session-*.jsonl, com modelo e tokens de cada
// resposta. Esses arquivos passam do limite de leitura do mod (4 MiB), então um
// Python curto resume cada um e devolve só os números.

const SCAN_TTL_MS = 10_000
const MAX_AGE_MS = 12 * 60 * 60 * 1000
const ALIVE_WINDOW_MS = 120_000

/** Lê os arquivos passados e imprime uma linha JSON de resumo por arquivo. */
const SUMMARIZE = String.raw`
import json, sys
for path in sys.argv[1:]:
    s = {"path": path, "tokens": {"input": 0, "output": 0, "cached": 0, "thoughts": 0}, "actions": 0, "files": []}
    try:
        with open(path) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if "startTime" in e and "start" not in s:
                    s["start"] = e["startTime"]
                    s["sessionId"] = e.get("sessionId")
                t = e.get("type")
                if t == "user" and "title" not in s:
                    c = e.get("content")
                    parts = c if isinstance(c, list) else [{"text": c}]
                    text = "\n".join(p.get("text", "") for p in parts if isinstance(p, dict) and isinstance(p.get("text"), str))
                    if text.strip() and not text.lstrip().startswith("<session_context>"):
                        s["title"] = next((l.strip() for l in text.splitlines() if l.strip()), "")[:200]
                elif t == "gemini":
                    if e.get("model"):
                        s["model"] = e["model"]
                    for k in ("input", "output", "cached", "thoughts"):
                        v = (e.get("tokens") or {}).get(k)
                        if isinstance(v, (int, float)):
                            s["tokens"][k] += v
                    for tc in e.get("toolCalls") or []:
                        s["actions"] += 1
                        a = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                        s["last"] = {"name": tc.get("name", ""), "args": {k: a[k] for k in ("file_path", "path", "dir_path", "command", "pattern") if isinstance(a.get(k), str)}, "at": tc.get("timestamp") or e.get("timestamp")}
                        fp = a.get("file_path")
                        if tc.get("name") in ("write_file", "replace") and isinstance(fp, str) and fp not in s["files"]:
                            s["files"].append(fp)
    except Exception:
        continue
    print(json.dumps(s))
`

export type Summary = {
  path: string
  sessionId?: string
  start?: string
  title?: string
  model?: string
  tokens: { input: number; output: number; cached: number; thoughts: number }
  actions: number
  last?: { name: string; args: Record<string, unknown>; at?: string }
  files: string[]
}

export const parseSummaries = (stdout: string): Summary[] =>
  stdout
    .split('\n')
    .map(l => {
      try {
        return JSON.parse(l) as Summary
      } catch {
        return undefined
      }
    })
    .filter((s): s is Summary => !!s && typeof s.path === 'string')

/** "~/.gemini/tmp/homolog/chats/x.jsonl" → "homolog" */
export const projectOf = (path: string) => path.split('/').slice(-3, -2)[0] ?? ''

/** Rodando quando há um processo do gemini que começou até 2 min antes da sessão (o CLI grava o início logo depois de abrir). */
export const isAlive = (start: number, procStarts: number[]) => procStarts.some(p => p <= start + 5000 && start - p < ALIVE_WINDOW_MS)

/** Uma execução do Gemini CLI como linha do painel. */
export const cliRun = (
  s: Summary,
  mtime: number,
  procStarts: number[] | undefined,
  now: number,
  describe: (tool: string, params: Record<string, unknown>) => string,
): Run => {
  const start = Date.parse(s.start ?? '') || mtime
  const running = procStarts ? isAlive(start, procStarts) : now - mtime < ALIVE_WINDOW_MS
  const model = s.model ?? 'gemini'
  const t = s.tokens
  return {
    id: `gemini-cli:${s.sessionId ?? s.path}`,
    type: 'gemini',
    description: projectOf(s.path),
    title: s.title,
    external: true,
    model,
    startedAt: start,
    endedAt: running ? undefined : mtime,
    exit: running ? undefined : 0,
    steps: 0,
    tools: 0,
    actions: s.actions,
    lastAction: s.last ? describe(s.last.name, s.last.args) : undefined,
    lastActionAt: Date.parse(s.last?.at ?? '') || undefined,
    activityAt: mtime,
    byModel: {
      [model]: { input: Math.max(0, t.input - t.cached), output: t.output + t.thoughts, cacheRead: t.cached, cacheWrite: 0 },
    },
    added: 0,
    removed: 0,
    files: s.files,
  }
}

/** Início (ms) de cada processo do Gemini CLI vivo agora; undefined se o ps falhar. */
async function geminiProcStarts($: EngineInterface, now: number) {
  try {
    const r = await $.process.run(['ps', '-axo', 'etime=,args='], { timeoutMs: 5000 })
    if (r.exitCode !== 0) return undefined
    const starts: number[] = []
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.*)$/)
      if (!m || !/(?:^|\/|\s)gemini\s/.test(`${m[5]} `) || /script\/gemini-dev/.test(m[5] ?? '')) continue
      const secs = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
      starts.push(now - secs * 1000)
    }
    return starts
  } catch {
    return undefined
  }
}

const cache = new Map<string, { mtime: number; summary: Summary }>()
let last = { at: -Infinity, runs: [] as Run[] }

/** As execuções do Gemini CLI das últimas 12 h, de qualquer pasta; lido no máximo a cada 10 s. */
export async function scanGeminiCli(
  $: EngineInterface,
  now: number,
  describe: (tool: string, params: Record<string, unknown>) => string,
) {
  if (now - last.at < SCAN_TTL_MS) return last.runs
  last = { ...last, at: now }
  try {
    const home = await $.env.get('HOME')
    if (!home) return last.runs
    const root = `${home}/.gemini/tmp`
    const files: { path: string; mtime: number }[] = []
    for (const dir of await $.fs.list(root)) {
      let chats
      try {
        chats = await $.fs.list(`${root}/${dir.name}/chats`)
      } catch {
        continue
      }
      for (const f of chats)
        if (f.name.endsWith('.jsonl') && now - f.mtimeMs < MAX_AGE_MS) files.push({ path: `${root}/${dir.name}/chats/${f.name}`, mtime: f.mtimeMs })
    }
    const stale = files.filter(f => cache.get(f.path)?.mtime !== f.mtime)
    if (stale.length) {
      const r = await $.process.run(['python3', '-I', '-c', SUMMARIZE, ...stale.map(f => f.path)], { timeoutMs: 20_000 })
      const byPath = new Map(parseSummaries(r.stdout).map(s => [s.path, s]))
      for (const f of stale) {
        const s = byPath.get(f.path)
        if (s) cache.set(f.path, { mtime: f.mtime, summary: s })
      }
    }
    const procStarts = await geminiProcStarts($, now)
    const runs = files.flatMap(f => {
      const c = cache.get(f.path)
      return c ? [cliRun(c.summary, f.mtime, procStarts, now, describe)] : []
    })
    last = { at: now, runs }
  } catch {}
  return last.runs
}
