import { NextRequest } from "next/server"
import crypto from "crypto"
import { promises as fs } from "fs"
import os from "os"
import path from "path"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const OPENCLAW_GATEWAY_HTTP = process.env.OPENCLAW_NATIVE_HTTP_URL || "http://127.0.0.1:18789"
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json")
const OPENCLAW_NATIVE_ACCESS_COOKIE = "siragpt_openclaw_native_access"
const OPENCLAW_NATIVE_ACCESS_TTL_SECONDS = Number(process.env.OPENCLAW_NATIVE_ACCESS_TTL_SECONDS || 12 * 60 * 60)
const nativeGatewayTokenCache = new Map<string, { token: string; exp: number }>()

type RouteContext = {
  params: {
    path?: string[]
  }
}

async function proxyOpenClawNative(request: NextRequest, context: RouteContext) {
  let pathParts = context.params.path || []
  const pathAccessToken = pathParts[0] === "__access" && pathParts[1] ? decodeURIComponent(pathParts[1]) : null
  if (pathAccessToken) {
    pathParts = pathParts.slice(2)
  }
  const path = pathParts.join("/")
  const access = readNativeAccess(request, pathAccessToken)
  if (!access) {
    return new Response("OpenClaw native access is required.", { status: 401 })
  }

  const requestedSession = request.nextUrl.searchParams.get("session")
  if (requestedSession && requestedSession !== access.payload.session) {
    return new Response("OpenClaw session does not match the authenticated user.", { status: 403 })
  }

  let upstreamBaseUrl: string
  try {
    upstreamBaseUrl = normalizeOpenClawGatewayHttpUrl(access.payload.gatewayUrl)
  } catch {
    return new Response("OpenClaw gateway is not allowed.", { status: 403 })
  }
  const upstreamUrl = new URL(path ? `/${path}` : "/", upstreamBaseUrl)
  const upstreamSearch = new URLSearchParams(request.nextUrl.searchParams)
  upstreamSearch.delete("gatewayUrl")
  upstreamSearch.delete("token")
  upstreamSearch.delete("session")
  upstreamSearch.delete("access")
  upstreamUrl.search = upstreamSearch.toString()

  const headers = new Headers()
  const accept = request.headers.get("accept")
  if (accept) headers.set("accept", accept)
  const range = request.headers.get("range")
  if (range) headers.set("range", range)
  const queryGatewayToken = request.nextUrl.searchParams.get("token")
  if (queryGatewayToken) {
    rememberNativeGatewayToken(access.token, queryGatewayToken, access.payload.exp)
  }
  const gatewayToken = queryGatewayToken || readRememberedNativeGatewayToken(access.token) || await readOpenClawGatewayToken()
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
  if (access.fromQuery) {
    responseHeaders.append("set-cookie", buildNativeAccessCookie(access.token))
  }

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
    const headInjection = `${buildOpenClawAccessPathScript(access.token)}${buildOpenClawBootstrapScript(request)}${buildOpenClawModelLogoEnhancer()}`
    const nativeBaseHref = `/openclaw/native/__access/${encodeURIComponent(access.token)}/`
    const patchedHtml = html.includes("<head>")
      ? html.replace("<head>", `<head><base href="${nativeBaseHref}">${headInjection}`)
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

type NativeAccessPayload = {
  sub: string
  session: string
  gatewayUrl: string
  iat: number
  exp: number
}

function readNativeAccess(request: NextRequest, pathToken?: string | null): { token: string; payload: NativeAccessPayload; fromQuery: boolean } | null {
  const queryToken = request.nextUrl.searchParams.get("access")
  const cookieToken = request.cookies.get(OPENCLAW_NATIVE_ACCESS_COOKIE)?.value
  const refererToken = readNativeAccessFromReferer(request)
  const token = queryToken || pathToken || (cookieToken ? decodeURIComponent(cookieToken) : null) || refererToken
  if (!token) return null

  const payload = verifyNativeAccessToken(token)
  if (!payload) return null
  return { token, payload, fromQuery: Boolean(queryToken || pathToken || refererToken) }
}

function readNativeAccessFromReferer(request: NextRequest) {
  const referer = request.headers.get("referer")
  if (!referer) return null
  try {
    const url = new URL(referer)
    if (url.origin !== request.nextUrl.origin) return null
    if (!url.pathname.startsWith("/openclaw/native")) return null
    return url.searchParams.get("access")
  } catch {
    return null
  }
}

function verifyNativeAccessToken(token: string): NativeAccessPayload | null {
  const [encodedPayload, signature, extra] = token.split(".")
  if (!encodedPayload || !signature || extra) return null

  const expected = crypto
    .createHmac("sha256", getNativeAccessSecret())
    .update(encodedPayload)
    .digest("base64url")
  if (!timingSafeEqual(signature, expected)) return null

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as NativeAccessPayload
    if (!payload?.sub || !payload?.session || !payload?.gatewayUrl) return null
    if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

function timingSafeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function getNativeAccessSecret() {
  return process.env.OPENCLAW_NATIVE_ACCESS_SECRET || "siragpt-openclaw-native-access-v1"
}

function normalizeOpenClawGatewayHttpUrl(value: string) {
  const url = new URL(value || OPENCLAW_GATEWAY_HTTP)
  if (url.protocol === "ws:") url.protocol = "http:"
  if (url.protocol === "wss:") url.protocol = "https:"
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid OpenClaw gateway protocol")
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"])
  if (!loopbackHosts.has(hostname)) {
    throw new Error("OpenClaw gateway must be loopback")
  }

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  const configuredPort = Number(new URL(OPENCLAW_GATEWAY_HTTP).port || 18789)
  const inManagedRange = port >= 19100 && port <= 20099
  if (port !== configuredPort && !inManagedRange) {
    throw new Error("OpenClaw gateway port is not allowed")
  }

  const pathname = url.pathname && url.pathname !== "/" ? url.pathname.replace(/\/+$/, "") : ""
  return `${url.protocol}//${url.host}${pathname}`
}

function buildNativeAccessCookie(token: string) {
  return [
    `${OPENCLAW_NATIVE_ACCESS_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/openclaw/native",
    `Max-Age=${OPENCLAW_NATIVE_ACCESS_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ")
}

function rememberNativeGatewayToken(accessToken: string, gatewayToken: string, exp: number) {
  nativeGatewayTokenCache.set(accessToken, { token: gatewayToken, exp })
  if (nativeGatewayTokenCache.size > 200) {
    const now = Date.now()
    for (const [key, value] of nativeGatewayTokenCache) {
      if (value.exp < now) nativeGatewayTokenCache.delete(key)
    }
  }
}

function readRememberedNativeGatewayToken(accessToken: string) {
  const cached = nativeGatewayTokenCache.get(accessToken)
  if (!cached) return null
  if (cached.exp < Date.now()) {
    nativeGatewayTokenCache.delete(accessToken)
    return null
  }
  return cached.token
}

function buildOpenClawAccessPathScript(accessToken: string) {
  const payload = {
    accessPath: `/openclaw/native/__access/${encodeURIComponent(accessToken)}`,
  }

  return `<script>(function(){try{var p=${toSafeInlineJson(payload)};function rewrite(value){try{var u=new URL(String(value),location.href);if(u.origin===location.origin&&u.pathname.indexOf('/openclaw/native/')===0&&u.pathname.indexOf('/openclaw/native/__access/')!==0){u.pathname=p.accessPath+u.pathname.slice('/openclaw/native'.length);return u.pathname+u.search+u.hash;}}catch(e){}return value;}var nativeFetch=window.fetch;if(typeof nativeFetch==='function'){window.fetch=function(input,init){try{if(typeof input==='string'||input instanceof URL){input=rewrite(input);}else if(input&&typeof input.url==='string'){var next=rewrite(input.url);if(next!==input.url&&typeof Request!=='undefined')input=new Request(next,input);}}catch(e){}return nativeFetch.call(this,input,init);};}if(window.XMLHttpRequest&&XMLHttpRequest.prototype&&XMLHttpRequest.prototype.open){var nativeOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){arguments[1]=rewrite(url);return nativeOpen.apply(this,arguments);};}function patchAttr(el,attr){try{var value=el.getAttribute(attr);if(!value)return;var next=rewrite(value);if(next!==value)el.setAttribute(attr,next);}catch(e){}}function patchNode(node){if(!node||node.nodeType!==1)return;patchAttr(node,'src');patchAttr(node,'href');if(node.querySelectorAll){node.querySelectorAll('[src],[href]').forEach(function(el){patchAttr(el,'src');patchAttr(el,'href');});}}new MutationObserver(function(mutations){mutations.forEach(function(mutation){mutation.addedNodes&&mutation.addedNodes.forEach(patchNode);if(mutation.type==='attributes')patchNode(mutation.target);});}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','href']});if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',function(){patchNode(document.documentElement);},{once:true});}else{patchNode(document.documentElement);}}catch(e){console.warn('SiraGPT OpenClaw access path patch failed',e);}})();</script>`
}

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

function buildOpenClawModelLogoEnhancer() {
  return `<style>
.chat-controls__model{position:relative}
.chat-controls__model>.siragpt-native-model-select{position:absolute!important;inset:auto!important;width:1px!important;height:1px!important;min-width:1px!important;opacity:0!important;pointer-events:none!important}
.siragpt-model-select{position:relative;width:100%;min-width:172px;color:inherit;font:inherit}
.siragpt-model-select__button{width:100%;height:38px;display:flex;align-items:center;gap:8px;padding:0 34px 0 12px;border:1px solid var(--border,#e5e5ea);border-radius:var(--radius-md,10px);background:var(--bg-elevated,#fff);color:var(--text,#3c3c43);font:inherit;line-height:1;cursor:pointer;text-align:left;box-shadow:none}
.siragpt-model-select__button:hover{border-color:var(--border-hover,#aeaeb2);background:var(--bg-hover,var(--bg-elevated,#fff))}
.siragpt-model-select__button:focus-visible,.siragpt-model-select.is-open .siragpt-model-select__button{outline:none;border-color:var(--accent,#ff3b3b);box-shadow:var(--focus-ring,0 0 0 3px color-mix(in srgb,#ff3b3b 18%,transparent))}
.siragpt-model-select__button:disabled{cursor:not-allowed;opacity:.55}
.siragpt-model-select__label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.siragpt-model-select__chevron{position:absolute;right:12px;top:50%;width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-65%) rotate(45deg);opacity:.62;pointer-events:none}
.siragpt-model-logo{width:20px;height:20px;min-width:20px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;background:#fff;border:1px solid rgba(15,23,42,.08);box-shadow:0 1px 1px rgba(15,23,42,.05)}
.siragpt-model-logo img{width:100%;height:100%;object-fit:contain;display:block;padding:2px}
.siragpt-model-logo--fallback{background:linear-gradient(135deg,var(--accent,#ff4d4d),var(--bg-hover,#1f2937));color:var(--accent-foreground,#fff);font-size:10px;font-weight:800;letter-spacing:0}
.siragpt-model-select__menu{position:absolute;z-index:1000;top:calc(100% + 6px);left:0;right:0;min-width:240px;max-height:280px;overflow:auto;padding:6px;border:1px solid var(--border,#e5e5ea);border-radius:var(--radius-lg,12px);background:var(--popover,#fff);color:var(--popover-foreground,var(--text,#3c3c43));box-shadow:var(--shadow-lg,0 18px 42px rgba(15,23,42,.18))}
.siragpt-model-select__option{width:100%;display:flex;align-items:center;gap:10px;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.siragpt-model-select__option:hover,.siragpt-model-select__option[aria-selected="true"]{background:var(--accent-subtle,color-mix(in srgb,#ff3b3b 12%,transparent))}
.siragpt-model-select__option[aria-selected="true"]{color:var(--accent,#ff3b3b);font-weight:650}
</style><script>(function(){try{
var MODEL_LOGOS=[
  {match:["deepseek"],src:"/icons/deepseek.png",name:"DeepSeek"},
  {match:["gpt","openai","chatgpt"],src:"/icons/openai.svg",name:"OpenAI"},
  {match:["gemini","google"],src:"/icons/gemini.svg",name:"Gemini"},
  {match:["claude","anthropic"],src:"/icons/claude.svg",name:"Claude"},
  {match:["grok","x-ai","xai"],src:"/icons/grok.png",name:"Grok"},
  {match:["kimi","moonshot"],src:"/icons/kimi.png",name:"Kimi"},
  {match:["openrouter"],src:"/icons/openrouter.png",name:"OpenRouter"},
  {match:["ollama"],src:"/icons/ollama.png",name:"Ollama"},
  {match:["z-ai","zai","glm"],src:"/icons/z-ai.svg",name:"Z.ai"}
];
var SELECTOR='select[data-chat-model-select="true"][aria-label="Chat model"]';
var enhanced=new WeakMap();
var openRoot=null;
function getOptionInfo(option){
  var label=(option&&option.textContent?option.textContent:"").trim()||"Model";
  var value=option?String(option.value||""):"";
  var source=(label+" "+value).toLowerCase();
  var logo=MODEL_LOGOS.find(function(entry){return entry.match.some(function(token){return source.indexOf(token)>-1;});});
  var fallback=(label.match(/[A-Za-z0-9]/)||["M"])[0].toUpperCase();
  return {label:label,value:value,src:logo&&logo.src,alt:logo?logo.name:label,fallback:fallback};
}
function createLogo(info){
  var logo=document.createElement("span");
  logo.className=info.src?"siragpt-model-logo":"siragpt-model-logo siragpt-model-logo--fallback";
  if(info.src){
    var img=document.createElement("img");
    img.src=info.src;
    img.alt=info.alt;
    img.loading="lazy";
    img.addEventListener("error",function(){
      logo.className="siragpt-model-logo siragpt-model-logo--fallback";
      logo.textContent=info.fallback;
    },{once:true});
    logo.appendChild(img);
  }else{
    logo.textContent=info.fallback;
  }
  return logo;
}
function closeOpen(except){
  if(openRoot&&openRoot!==except){
    openRoot.classList.remove("is-open");
    var menu=openRoot.querySelector(".siragpt-model-select__menu");
    if(menu) menu.hidden=true;
  }
  if(!except) openRoot=null;
}
function render(select,state){
  var selected=select.selectedOptions&&select.selectedOptions[0]?select.selectedOptions[0]:select.options[select.selectedIndex]||select.options[0];
  var selectedInfo=getOptionInfo(selected);
  state.button.disabled=select.disabled;
  state.button.setAttribute("aria-expanded",state.root.classList.contains("is-open")?"true":"false");
  state.button.replaceChildren(createLogo(selectedInfo),state.label,state.chevron);
  state.label.textContent=selectedInfo.label;
  state.menu.replaceChildren();
  Array.prototype.forEach.call(select.options,function(option){
    var info=getOptionInfo(option);
    var item=document.createElement("button");
    item.type="button";
    item.className="siragpt-model-select__option";
    item.setAttribute("role","option");
    item.setAttribute("aria-selected",option.value===select.value?"true":"false");
    item.dataset.value=option.value;
    var text=document.createElement("span");
    text.className="siragpt-model-select__label";
    text.textContent=info.label;
    item.append(createLogo(info),text);
    item.addEventListener("click",function(event){
      event.preventDefault();
      if(select.value!==option.value){
        select.value=option.value;
        select.dispatchEvent(new Event("input",{bubbles:true}));
        select.dispatchEvent(new Event("change",{bubbles:true}));
      }
      closeOpen();
      render(select,state);
    });
    state.menu.appendChild(item);
  });
}
function enhance(select){
  if(enhanced.has(select)){
    var existing=enhanced.get(select);
    if(existing&&existing.root&&existing.root.isConnected) return;
    enhanced.delete(select);
  }
  var parent=select.closest(".chat-controls__model")||select.parentElement;
  if(!parent) return;
  select.classList.add("siragpt-native-model-select");
  var root=document.createElement("div");
  root.className="siragpt-model-select";
  var button=document.createElement("button");
  button.type="button";
  button.className="siragpt-model-select__button";
  button.setAttribute("aria-haspopup","listbox");
  button.setAttribute("aria-label","Chat model");
  var label=document.createElement("span");
  label.className="siragpt-model-select__label";
  var chevron=document.createElement("span");
  chevron.className="siragpt-model-select__chevron";
  chevron.setAttribute("aria-hidden","true");
  var menu=document.createElement("div");
  menu.className="siragpt-model-select__menu";
  menu.setAttribute("role","listbox");
  menu.hidden=true;
  root.append(button,menu);
  parent.appendChild(root);
  var state={root:root,button:button,label:label,chevron:chevron,menu:menu};
  enhanced.set(select,state);
  button.addEventListener("click",function(event){
    event.preventDefault();
    if(button.disabled) return;
    var next=!root.classList.contains("is-open");
    closeOpen(root);
    root.classList.toggle("is-open",next);
    menu.hidden=!next;
    button.setAttribute("aria-expanded",next?"true":"false");
    openRoot=next?root:null;
  });
  select.addEventListener("change",function(){render(select,state);});
  new MutationObserver(function(){render(select,state);}).observe(select,{attributes:true,childList:true,subtree:true});
  render(select,state);
}
function enhanceAll(){
  Array.prototype.forEach.call(document.querySelectorAll(SELECTOR),enhance);
}
var scheduled=false;
function scheduleEnhance(){
  if(scheduled) return;
  scheduled=true;
  requestAnimationFrame(function(){scheduled=false;enhanceAll();});
}
document.addEventListener("click",function(event){
  if(openRoot&&!openRoot.contains(event.target)) closeOpen();
});
document.addEventListener("keydown",function(event){
  if(event.key==="Escape") closeOpen();
});
new MutationObserver(function(mutations){
  var shouldEnhance=mutations.some(function(mutation){
    return Array.prototype.some.call(mutation.addedNodes,function(node){
      return node.nodeType===1&&(node.matches&&node.matches(SELECTOR)||node.querySelector&&node.querySelector(SELECTOR));
    });
  });
  if(shouldEnhance) scheduleEnhance();
}).observe(document.documentElement,{childList:true,subtree:true});
if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",enhanceAll,{once:true});
}else{
  enhanceAll();
}
setTimeout(enhanceAll,500);
setTimeout(enhanceAll,1500);
}catch(e){console.warn("SiraGPT model logo enhancer failed",e);}})();</script>`
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
