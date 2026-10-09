import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createAuthenticatedFetch } from "@/lib/authenticated-fetch"
const BASE = "https://api.sira.test/api"
const json = (status: number, body: object = {}) => new Response(JSON.stringify(body), {status, headers: {"Content-Type":"application/json"}})
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return {promise, resolve} }
const fresh = (init?: RequestInit) => new Headers(init?.headers).get("Authorization") === "Bearer refreshed"
describe("refresh replay and session identity", () => {
  beforeEach(() => localStorage.setItem("auth-token", "expired"))
  afterEach(() => localStorage.clear())
  it.each(["header", "option", "request"])("uses the minted credential with an explicit %s", async mode => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input instanceof Request ? input.url : input).endsWith("/auth/refresh") ? json(200,{token:"refreshed"}) : json(fresh(init)?200:401))
    const transport = createAuthenticatedFetch({apiBaseUrl:BASE,fetchImpl:fetchImpl as typeof fetch})
    const input = mode === "request" ? new Request(BASE+"/credits/me",{headers:{Authorization:"Bearer expired"}}) : BASE+"/credits/me"
    const res = await transport(input,mode === "header"?{headers:{Authorization:"Bearer expired"}}:{},mode === "option"?{bearerToken:"expired"}:{})
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(localStorage.getItem("auth-token")).toBe("refreshed")
  })
  it("keeps explicit cookie-only authentication on the replay", async () => {
    let attempts=0
    const fetchImpl=vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if(String(input).endsWith("/auth/refresh")) return json(200,{token:"refreshed"})
      expect(new Headers(init?.headers).has("Authorization")).toBe(false)
      return json(++attempts===1?401:200)
    })
    const transport=createAuthenticatedFetch({apiBaseUrl:BASE,fetchImpl:fetchImpl as typeof fetch})
    expect((await transport(BASE+"/credits/me",{}, {bearerToken:null})).status).toBe(200)
    expect(attempts).toBe(2)
  })
  it.each(["account", "logout"])("discards a late refresh after %s changes the session", async mode => {
    const gate=deferred<Response>(),started=deferred<void>()
    const fetchImpl=vi.fn(async (input: RequestInfo | URL) => {
      if(String(input).endsWith("/auth/refresh")){started.resolve();return gate.promise}
      return json(401)
    })
    const transport=createAuthenticatedFetch({apiBaseUrl:BASE,fetchImpl:fetchImpl as typeof fetch})
    const pending=transport(BASE+"/credits/me")
    await started.promise
    if(mode==="account") localStorage.setItem("auth-token","other-account"); else localStorage.removeItem("auth-token")
    gate.resolve(json(200,{token:"refreshed"}))
    expect((await pending).status).toBe(401)
    expect(localStorage.getItem("auth-token")).toBe(mode==="account"?"other-account":null)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it("coalesces concurrent refreshes and replays each same-session request", async () => {
    const gate=deferred<Response>(),started=deferred<void>()
    let refreshes=0
    const fetchImpl=vi.fn(async(input: RequestInfo | URL,init?: RequestInit)=>{
      if(String(input).endsWith("/auth/refresh")){refreshes++;started.resolve();return gate.promise}
      return json(fresh(init)?200:401)
    })
    const transport=createAuthenticatedFetch({apiBaseUrl:BASE,fetchImpl:fetchImpl as typeof fetch})
    const one=transport(BASE+"/one",{}, {bearerToken:"expired"})
    const two=transport(BASE+"/two",{}, {bearerToken:"expired"})
    await started.promise
    gate.resolve(json(200,{token:"refreshed"}))
    expect((await Promise.all([one,two])).map(r=>r.status)).toEqual([200,200])
    expect(refreshes).toBe(1)
  })
  it("does not share a refresh result with another transport context",async()=>{
    const gate=deferred<Response>(),started=deferred<void>()
    const fetchA=vi.fn(async(input: RequestInfo | URL,init?: RequestInit)=>{
      if(String(input).endsWith("/auth/refresh")){started.resolve();return gate.promise}
      return json(fresh(init)?200:401)
    })
    const fetchB=vi.fn(async(input: RequestInfo | URL)=>String(input).endsWith("/auth/refresh")?json(401):json(401))
    const a=createAuthenticatedFetch({apiBaseUrl:BASE,fetchImpl:fetchA as typeof fetch})
    const b=createAuthenticatedFetch({apiBaseUrl:"https://other.sira.test/api",fetchImpl:fetchB as typeof fetch})
    const pending=a(BASE+"/one")
    await started.promise
    const other=b("https://other.sira.test/api/two")
    gate.resolve(json(200,{token:"refreshed"}))
    await pending; await other
    expect(fetchB.mock.calls.filter(([url])=>String(url).endsWith("/auth/refresh"))).toHaveLength(1)
  })
  it("preserves a consumed Request mutation, headers, idempotency and signal",async()=>{
    const bodies:string[]=[],keys:(string|null)[]=[],controller=new AbortController()
    const fetchImpl=vi.fn(async(input: RequestInfo | URL,init?: RequestInit)=>{
      if(String(input instanceof Request?input.url:input).endsWith("/auth/refresh"))return json(200,{token:"refreshed"})
      bodies.push(await new Request(input,init).text());keys.push(new Headers(init?.headers).get("Idempotency-Key"));expect(init?.signal).toBe(controller.signal)
      return json(fresh(init)?200:401)
    })
    const transport=createAuthenticatedFetch({apiBaseUrl:BASE,fetchImpl:fetchImpl as typeof fetch})
    const request=new Request(BASE+"/documents",{method:"POST",headers:{Authorization:"Bearer expired","Idempotency-Key":"same-operation"},body:"same payload"})
    expect((await transport(request,{signal:controller.signal})).status).toBe(200)
    expect(bodies).toEqual(["same payload","same payload"])
    expect(keys).toEqual(["same-operation","same-operation"])
  })
  it("replays concurrent memory-token callers after their refresh callback",async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(window,"localStorage")!
    Object.defineProperty(window,"localStorage",{configurable:true,get(){throw new DOMException("blocked","SecurityError")}})
    try{
      let token="expired",refreshes=0
      const gate=deferred<Response>(),started=deferred<void>()
      const fetchImpl=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
        if(String(input).endsWith("/auth/refresh")){refreshes++;started.resolve();return gate.promise}
        return json(fresh(init)?200:401)
      })
      const transport=createAuthenticatedFetch({apiBaseUrl:BASE,fetchImpl:fetchImpl as typeof fetch,getBearerToken:()=>token})
      const options={onTokenRefreshed:(value:string)=>{token=value}}
      const first=transport(BASE+"/one",{},options),second=transport(BASE+"/two",{},options)
      await started.promise;gate.resolve(json(200,{token:"refreshed"}))
      expect((await Promise.all([first,second])).map(r=>r.status)).toEqual([200,200]);expect(refreshes).toBe(1)
    }finally{Object.defineProperty(window,"localStorage",descriptor)}
  })
  it("does not replay when the caller aborts while refreshing",async()=>{
    const gate=deferred<Response>(),started=deferred<void>(),controller=new AbortController()
    const fetchImpl=vi.fn(async(input: RequestInfo | URL)=>{
      if(String(input).endsWith("/auth/refresh")){started.resolve();return gate.promise}
      return json(401)
    })
    const transport=createAuthenticatedFetch({apiBaseUrl:BASE,fetchImpl:fetchImpl as typeof fetch})
    const pending=transport(BASE+"/one",{signal:controller.signal})
    await started.promise;controller.abort();gate.resolve(json(200,{token:"refreshed"}))
    expect((await pending).status).toBe(401)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
