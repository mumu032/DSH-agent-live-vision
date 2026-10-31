/**
 * agent-live —— DSH 插件（host 半端）
 * ============================================================================
 * 这个包有两种活法：
 *   1. 命令行：`node server.mjs` 自己占一个端口（3110/3112）。给不装 DSH 的人用。
 *   2. DSH 插件：被 DSH 载入，把同一套页面挂到 DSH 自己的 web server 下的
 *      `/api/agent-live` 前缀里 —— 不开新端口、不用额外起进程，DSH 开着它就在。
 *
 * 配置：优先 `LIVE_CONFIG` 环境变量指向的 json；否则找包目录下的 `config.json`；
 * 都没有就用包内 fixtures 里的示例数据（demo），先让人看见东西，再让他去配自己的账本。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'agent-live'
export const inject = ['webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.dirname(HERE)
const PREFIX = '/api/agent-live'

const CONFIG_NAME = 'agent-live.json'
const DSH_HOMES = [
  process.env.DSH_HOME,
  path.join(os.homedir(), '.dsh'),
  process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : '',
  process.env.HOME ? path.join(process.env.HOME, '.dsh') : '',
].filter(Boolean)

export function configCandidates() {
  const list = [
    process.env.LIVE_CONFIG,
    path.join(PKG, 'config.json'),
    path.join(process.cwd(), 'config.json'),
  ]
  for (const home of DSH_HOMES) list.push(path.join(home, CONFIG_NAME))
  // 同一个目录可能从 DSH_HOME 与 USERPROFILE 各算一次，去重后更好读
  return [...new Set(list.filter(Boolean))]
}

export function findConfig() {
  for (const c of configCandidates()) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  return ''
}

/** 排障用：把这几个候选路径原样吐出来，装完看一眼就知道它到底在找哪儿。 */
export function configHint() {
  return configCandidates().map((c) => (fs.existsSync(c) ? '+ ' : '- ') + c).join('\n')
}

export async function apply(ctx) {
  const file = findConfig()

  // 配置必须在 import 之前定好：server.mjs 是模块级单例，载入时就把账本路径算死了。
  // 用 URL query 传，不动 process.env —— 宿主 env 会被它拉起的每个子进程继承，改了很难收场。
  // ESM 是按 URL 缓存的。把 server.mjs 的 mtime 拼进 query：改了代码重装一次就能拿到
  // 新模块，不用为了插件重启整个 DSH。
  const stamp = (() => {
    try { return String(Math.floor(statSync(new URL('../server.mjs', import.meta.url)).mtimeMs)) } catch { return '0' }
  })()
  const spec = file
    ? '../server.mjs?config=' + encodeURIComponent(file) + '&b=' + stamp
    : '../server.mjs?demo=1&b=' + stamp
  const live = await import(spec)
  live.startEngine()

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      live.handleRequest(req, res, PREFIX).catch((e) => {
        try {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('agent-live: ' + (e?.message ?? String(e)))
        } catch { /* 已经写过头了就算了 */ }
      })
    },
  }), `agent-live: ${PREFIX}`)

  console.log(`[agent-live] 已挂载 ${PREFIX}（配置：${file || '没找到 config.json，先用示例数据跑起来'}）`)
}
