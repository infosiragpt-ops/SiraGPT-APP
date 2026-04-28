import { NextRequest } from "next/server"
import { promises as fs } from "fs"
import os from "os"
import path from "path"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const OPENCLAW_GATEWAY_HTTP = process.env.OPENCLAW_NATIVE_HTTP_URL || "http://127.0.0.1:18789"
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json")

type RouteContext = {
  params: {
    path?: string[]
  }
}

async function proxyOpenClawNative(request: NextRequest, context: RouteContext) {
  const path = (context.params.path || []).join("/")
  const upstreamUrl = new URL(path ? `/${path}` : "/", OPENCLAW_GATEWAY_HTTP)
  const upstreamSearch = new URLSearchParams(request.nextUrl.searchParams)
  upstreamSearch.delete("gatewayUrl")
  upstreamSearch.delete("token")
  upstreamSearch.delete("session")
  upstreamUrl.search = upstreamSearch.toString()

  const headers = new Headers()
  const accept = request.headers.get("accept")
  if (accept) headers.set("accept", accept)
  const range = request.headers.get("range")
  if (range) headers.set("range", range)
  const gatewayToken = request.nextUrl.searchParams.get("token") || await readOpenClawGatewayToken()
  if (gatewayToken) headers.set("authorization", `Bearer ${gatewayToken}`)

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    cache: "no-store",
  })

  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.delete("x-frame-options")
  responseHeaders.delete("content-security-policy")
  responseHeaders.delete("content-security-policy-report-only")
  responseHeaders.delete("cross-origin-opener-policy")
  responseHeaders.delete("cross-origin-embedder-policy")
  responseHeaders.set("cache-control", "no-store")
  responseHeaders.set("x-siragpt-openclaw-proxy", "native")

  if (request.method === "HEAD") {
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  }

  const contentType = responseHeaders.get("content-type") || ""
  if (contentType.includes("text/html")) {
    responseHeaders.delete("content-length")
    const html = await upstream.text()
    const bootstrapScript = buildOpenClawBootstrapScript(request)
    const patchedHtml = html.includes("<head>")
      ? html.replace("<head>", `<head><base href="/openclaw/native/">${bootstrapScript}`)
      : html
    return new Response(patchedHtml, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

export const GET = proxyOpenClawNative
export const HEAD = proxyOpenClawNative

function buildOpenClawBootstrapScript(request: NextRequest) {
  const gatewayUrl = request.nextUrl.searchParams.get("gatewayUrl")
  const token = request.nextUrl.searchParams.get("token")
  const sessionKey = request.nextUrl.searchParams.get("session") || "main"
  if (!gatewayUrl || !token) return ""

  const payload = {
    gatewayUrl,
    token,
    sessionKey,
  }

  return `<script>(function(){try{var p=${toSafeInlineJson(payload)};var key=(function(v){try{var u=new URL(v,location.href);var path=u.pathname==='/'?'':(u.pathname.replace(/\\/+$/,'')||u.pathname);return u.protocol+'//'+u.host+path;}catch(e){return v;}})(p.gatewayUrl);var settings={gatewayUrl:p.gatewayUrl,sessionKey:p.sessionKey,lastActiveSessionKey:p.sessionKey,theme:'claw',themeMode:'system',chatFocusMode:false,chatShowThinking:true,chatShowToolCalls:true,splitRatio:0.6,navCollapsed:false,navWidth:220,navGroupsCollapsed:{},borderRadius:50};try{sessionStorage.setItem('openclaw.control.token.v1:'+key,p.token);}catch(e){}localStorage.setItem('openclaw.control.token.v1:'+key,p.token);localStorage.setItem('openclaw.control.settings.v1:'+key,JSON.stringify(settings));localStorage.setItem('openclaw.control.settings.v1:default',JSON.stringify(settings));history.replaceState(null,'',location.pathname+location.hash);}catch(e){}})();</script>`
}

function toSafeInlineJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

async function readOpenClawGatewayToken() {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_NATIVE_GATEWAY_TOKEN
  if (envToken && envToken.trim()) return envToken.trim()

  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG_PATH, "utf8")
    const config = JSON.parse(raw)
    const token =
      config?.gateway?.auth?.token ||
      config?.gatewayToken ||
      config?.auth?.token ||
      config?.token
    return token && String(token).trim() ? String(token).trim() : null
  } catch {
    return null
  }
}
