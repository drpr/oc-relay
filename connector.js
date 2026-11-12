#!/usr/bin/env node
/**
 * OpenCode Connector — Mac 端
 *
 * 职责：
 *   1. 用 @opentunnel/client 连到「自建 coordinator」，建立盲 TLS 隧道
 *   2. 把隧道入口登记到 relay 的环境注册表（账号 → 环境列表）
 *   3. 定期心跳 + 探活，让 relay 知道这台机器还在线
 *
 * 与 opencode 内置隧道的关系：
 *   opencode 二进制硬编码了 https://opentunnel.xyz，无法指向自建 coordinator。
 *   所以这里用独立的 opentunnel 客户端连自建 coordinator，
 *   把本地 opencode 服务（127.0.0.1:PORT）作为一条 route 暴露出去。
 *   opencode 本身不需要改任何配置，它照常在本地跑。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { create } from '@opentunnel/client'

const CONFIG_PATH =
  process.env.OC_CONNECTOR_CONFIG ||
  path.join(os.homedir(), '.config', 'oc-connector', 'config.json')

const config = loadConfig()

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    console.error(`missing config: ${CONFIG_PATH}`)
    console.error('run: node connector.js --init')
    process.exit(1)
  }
}

function saveConfig(next) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 })
}

// ── 工具 ────────────────────────────────────────────────────────────────

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

async function api(pathname, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(new URL(pathname, config.relayBase), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { raw: text }
  }
  if (!response.ok) {
    const detail = parsed?.error || parsed?.message || response.statusText
    throw new Error(`${method} ${pathname} -> ${response.status}: ${detail}`)
  }
  return parsed
}

// ── 隧道 ────────────────────────────────────────────────────────────────

async function openTunnel() {
  const client = create({
    api: config.coordinatorApi,
    store: OpenTunnelStorage.xdg(),
  })

  // 独立的 profile，避免和官方 opentunnel.xyz 的隧道身份混用
  const profile = config.profile || 'relay'

  let identity
  try {
    identity = await client.tunnel.ensure({
      profile,
      onProgress: (stage) => log('tunnel stage:', stage),
    })
  } catch (error) {
    log('ensure failed:', error.message, '- creating a new tunnel')
    identity = await client.tunnel.create({ profile })
  }
  log('tunnel identity:', identity.id, identity.hostname)

  const connection = await client.tunnel.connect({
    profile,
    routes: {
      // route 名决定 URL：https://<route>.<id>.<domain>
      // 用一个不可猜的名字，避免被别人猜到入口
      [config.routeName]: `127.0.0.1:${config.opencodePort}`,
    },
  })

  log('tunnel up. urls:', JSON.stringify(connection.urls))
  return { client, connection, identity }
}

// 动态 import storage（它是 @opentunnel/client 的具名导出）
const { OpenTunnelStorage } = await import('@opentunnel/client')

// ── 主流程 ──────────────────────────────────────────────────────────────

async function main() {
  const token = config.relayToken
  if (!token) throw new Error('relayToken missing in config')

  // 1. 确认 relay 账号有效
  const me = await api('/api/auth/me', { token })
  log('relay account:', me.user.username)

  // 2. 建立隧道
  const { connection, identity } = await openTunnel()

  // 3. 组装隧道入口 URL
  //    routes 的 URL 形状：https://<route>.<hostname>
  const routeUrl = connection.urls?.[config.routeName] || connection.urls?.['@']
  if (!routeUrl) throw new Error('tunnel did not expose a route url')
  log('tunnel route url:', routeUrl)

  // 4. 探活目标 opencode，确认它真的在跑
  const opencodeUp = await probeOpencode()
  log('opencode local probe:', opencodeUp ? 'up' : 'down')

  // 5. 注册环境
  const existing = await api('/api/environments', { token })
  const match = existing.environments.find((e) => e.name === config.environmentName)

  const payload = {
    name: config.environmentName,
    description: config.description || 'opencode on mac',
    url: routeUrl,
    username: config.opencodeUsername || 'opencode',
    password: config.opencodePassword,
    hostname: os.hostname(),
    version: opencodeVersion(),
    platform: `${os.platform()}-${os.arch()}`,
    tunnelHostname: identity.hostname,
    status: opencodeUp ? 'online' : 'degraded',
  }

  let environment
  if (match) {
    environment = (await api(`/api/environments/${match.id}`, { method: 'PATCH', token, body: payload })).environment
    log('environment updated:', environment.id)
  } else {
    environment = (await api('/api/environments', { method: 'POST', token, body: payload })).environment
    log('environment registered:', environment.id)
  }

  // 6. 心跳循环
  log('heartbeat every', config.heartbeatSeconds, 's')
  const timer = setInterval(async () => {
    try {
      const result = await api(`/api/environments/${environment.id}/heartbeat`, {
        method: 'POST',
        token,
        body: { version: opencodeVersion(), platform: payload.platform, hostname: payload.hostname },
      })
      log('heartbeat:', result.environment.status)
    } catch (error) {
      log('heartbeat failed:', error.message)
    }
  }, (config.heartbeatSeconds || 60) * 1000)

  // 隧道断开则退出，让 launchd 拉起
  connection.closed.then(() => {
    log('tunnel closed, exiting')
    clearInterval(timer)
    process.exit(1)
  })

  const shutdown = async () => {
    log('shutting down')
    clearInterval(timer)
    try {
      await connection.close()
    } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function probeOpencode() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const auth = Buffer.from(`${config.opencodeUsername || 'opencode'}:${config.opencodePassword}`).toString('base64')
    const response = await fetch(`http://127.0.0.1:${config.opencodePort}/api/info`, {
      headers: { authorization: `Basic ${auth}` },
      signal: controller.signal,
    })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

function opencodeVersion() {
  try {
    // ESM 里没有 require，用 createRequire 拿到同步 API。
    const { execFileSync } = createRequire(import.meta.url)('node:child_process')
    const out = execFileSync(
      process.env.HOME + '/.opencode/bin/opencode',
      ['--version'],
      { encoding: 'utf8', timeout: 5000 }
    )
    return out.trim().replace(/^opencode\s+/, '')
  } catch {
    return 'unknown'
  }
}

// ── init 模式：生成配置模板 ─────────────────────────────────────────────

if (process.argv.includes('--init')) {
  const template = {
    relayBase: 'https://43.135.23.149:9999',
    relayToken: '',
    coordinatorApi: 'https://ot.43-135-23-149.nip.io',
    caCertPath: path.join(os.homedir(), '.config', 'oc-connector', 'coordinator-ca.pem'),
    profile: 'relay',
    opencodePort: 49374,
    opencodeUsername: 'opencode',
    opencodePassword: '',
    environmentName: 'mac-alex',
    description: 'opencode on mac',
    routeName: 'oc' + crypto.randomBytes(4).toString('hex'),
    heartbeatSeconds: 60,
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2), { mode: 0o600 })
  console.log('wrote', CONFIG_PATH)
  console.log('fill in relayToken / opencodePassword / caCertPath, then run: node connector.js')
  process.exit(0)
}

main().catch((error) => {
  log('fatal:', error.message)
  process.exit(1)
})
