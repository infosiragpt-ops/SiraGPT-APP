import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
vi.mock("@/lib/client-logs",()=>({reportClientLog:vi.fn()}))
import {apiClient as api} from "@/lib/api"
import {clearAuthRefreshBlock,authenticatedFetch} from "@/lib/authenticated-fetch"
const json=(status:number,body:object={})=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}})
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return{promise,resolve}}
const fetchMock=vi.fn()
describe("ApiClient refresh identity",()=>{
 beforeEach(()=>{vi.restoreAllMocks();localStorage.clear();api.setToken("expired");(api as any)._refreshing=null;(api as any)._refreshBlockedUntil=0;clearAuthRefreshBlock();globalThis.fetch=fetchMock;fetchMock.mockReset();vi.spyOn(authenticatedFetch.csrfManager,"getToken").mockResolvedValue(null)})
 afterEach(()=>{vi.restoreAllMocks();api.setToken(null);localStorage.clear()})
 it("keeps subsequent requests on the token minted by the shared transport",async()=>{
  fetchMock.mockImplementation(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).endsWith("/auth/refresh")?json(200,{token:"refreshed"}):json(new Headers(init?.headers).get("Authorization")==="Bearer refreshed"?200:401,{user:{id:"synthetic"}}))
  await api.getCurrentUser();await api.getCurrentUser()
  expect(fetchMock.mock.calls.filter(([url])=>String(url).endsWith("/auth/refresh"))).toHaveLength(1)
  expect(fetchMock).toHaveBeenCalledTimes(4)
 })
 it.each([200,401])("preserves a new account after a late refresh %s",async status=>{
  const gate=deferred<Response>(),started=deferred<void>()
  fetchMock.mockImplementation(async()=>{started.resolve();return gate.promise})
  const pending=api._tryRefresh();await started.promise;api.setToken("other-account");gate.resolve(json(status,{token:"old-account-rotation"}))
  expect(await pending).toBe(false);expect(localStorage.getItem("auth-token")).toBe("other-account");expect(fetchMock).toHaveBeenCalledTimes(1)
 })
 it("invalidates logout followed by login even when the token string is reused",async()=>{
  const gate=deferred<Response>(),started=deferred<void>()
  fetchMock.mockImplementation(async()=>{started.resolve();return gate.promise})
  const pending=api._tryRefresh();await started.promise;api.setToken(null);api.setToken("expired");gate.resolve(json(200,{token:"obsolete-rotation"}))
  expect(await pending).toBe(false);expect(localStorage.getItem("auth-token")).toBe("expired")
 })
 it("bounds replays when refresh succeeds but the resource keeps rejecting access",async()=>{
  fetchMock.mockImplementation(async(url:RequestInfo|URL)=>String(url).endsWith("/auth/refresh")?json(200,{token:"refreshed"}):json(401,{error:"access_denied"}))
  await expect(api.getCurrentUser()).rejects.toMatchObject({status:401})
  expect(fetchMock).toHaveBeenCalledTimes(3)
 })
 it("retries a temporary server error after rotation within the same session",async()=>{
  let resources=0
  fetchMock.mockImplementation(async(url:RequestInfo|URL,init?:RequestInit)=>{
   if(String(url).endsWith("/auth/refresh")) return json(200,{token:"refreshed"})
   resources++
   if(resources===1) return json(401)
   expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer refreshed")
   return resources===2 ? new Response(JSON.stringify({error:"busy"}),{status:503,headers:{"Content-Type":"application/json","Retry-After":"0"}}) : json(200,{user:{id:"synthetic"}})
  })
  await expect(api.getCurrentUser()).resolves.toEqual({user:{id:"synthetic"}})
  expect(resources).toBe(3);expect(fetchMock).toHaveBeenCalledTimes(4)
 })
 it("lets a concurrent same-account rotation finish a delayed retry",async()=>{
  vi.useFakeTimers()
  try{
   const started=deferred<void>();let me=0
   fetchMock.mockImplementation(async(url:RequestInfo|URL,init?:RequestInit)=>{
    if(String(url).endsWith("/auth/refresh")) return json(200,{token:"refreshed"})
    if(String(url).endsWith("/auth/me") && ++me===1){started.resolve();return new Response("{}",{status:503,headers:{"Retry-After":"1"}})}
    expect(new Headers(init?.headers).get("Authorization")).toBe(String(url).endsWith("/chats") && localStorage.getItem("auth-token")==="expired" ? "Bearer expired" : "Bearer refreshed")
    return json(new Headers(init?.headers).get("Authorization")==="Bearer refreshed"?200:401,{user:{id:"synthetic"},chats:[]})
   })
   const pending=api.getCurrentUser();await started.promise;await api.getChats({});await vi.advanceTimersByTimeAsync(1000)
   await expect(pending).resolves.toMatchObject({user:{id:"synthetic"}});expect(me).toBe(2)
  }finally{vi.useRealTimers()}
 })
 it("does not commit a late login after a newer identity was selected",async()=>{
  const gate=deferred<Response>(),started=deferred<void>()
  fetchMock.mockImplementation(async()=>{started.resolve();return gate.promise})
  const pending=api.login({email:"synthetic@example.test",password:"synthetic-password"});await started.promise;api.setToken("new-account");gate.resolve(json(200,{token:"late-login"}))
  await expect(pending).rejects.toMatchObject({status:401,code:"session_changed"});expect(localStorage.getItem("auth-token")).toBe("new-account")
 })
 it("clears the cached bearer when another tab signs out",async()=>{
  localStorage.removeItem("auth-token");window.dispatchEvent(new StorageEvent("storage",{key:"auth-token",oldValue:"expired",newValue:null}))
  fetchMock.mockImplementation(async(_url:RequestInfo|URL,init?:RequestInit)=>{expect(new Headers(init?.headers).has("Authorization")).toBe(false);return json(200,{user:{id:"cookie-session"}})})
  await api.getCurrentUser();expect(fetchMock).toHaveBeenCalledTimes(1)
 })
 it("keeps the refreshed token in memory when storage throws",async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(window,"localStorage")!
  Object.defineProperty(window,"localStorage",{configurable:true,get(){throw new DOMException("blocked","SecurityError")}})
  try{
   api.setToken("expired")
   fetchMock.mockImplementation(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).endsWith("/auth/refresh")?json(200,{token:"refreshed"}):json(new Headers(init?.headers).get("Authorization")==="Bearer refreshed"?200:401,{user:{id:"synthetic"}}))
   await api.getCurrentUser();await api.getCurrentUser()
   expect(fetchMock.mock.calls.filter(([url])=>String(url).endsWith("/auth/refresh"))).toHaveLength(1)
  }finally{Object.defineProperty(window,"localStorage",descriptor)}
 })
})

describe("ApiClient CSRF recovery failures", () => {
 beforeEach(() => {
  vi.restoreAllMocks(); localStorage.clear(); api.setToken("expired");
  (api as any)._refreshing = null; (api as any)._refreshBlockedUntil = 0;
  clearAuthRefreshBlock(); authenticatedFetch.csrfManager.clear();
  globalThis.fetch = fetchMock; fetchMock.mockReset();
  vi.spyOn(authenticatedFetch.csrfManager, "getToken").mockResolvedValue("csrf-current");
 })
 afterEach(() => { vi.restoreAllMocks(); api.setToken(null); localStorage.clear() })

 it("keeps credentials and the CSRF cause without starting the secondary refresh fallback", async () => {
  const expired = vi.fn(); window.addEventListener("siragpt:session-expired", expired)
  fetchMock.mockImplementation(async (url: RequestInfo | URL) => String(url).endsWith("/auth/refresh")
   ? json(403, { code: "csrf_invalid", error: "Renew the security token" }) : json(401))
  try {
   for (let i = 0; i < 4; i++) await expect(api.getCurrentUser()).rejects.toMatchObject({ status: 403, code: "csrf_invalid" })
   expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/auth/refresh"))).toHaveLength(2)
   expect(localStorage.getItem("auth-token")).toBe("expired")
   expect(expired).not.toHaveBeenCalled()
  } finally { window.removeEventListener("siragpt:session-expired", expired) }
 })

 it("does not erase a token or fall back to cookies after an explicit refresh receives CSRF rejection", async () => {
  const expired = vi.fn(); window.addEventListener("siragpt:session-expired", expired)
  fetchMock.mockImplementation(async () => json(403, { error: "csrf_invalid" }))
  try {
   expect(await api._tryRefresh()).toBe(false)
   expect(await api._tryRefresh()).toBe(false)
   expect(fetchMock).toHaveBeenCalledTimes(1)
   expect(localStorage.getItem("auth-token")).toBe("expired")
   expect(expired).not.toHaveBeenCalled()
  } finally { window.removeEventListener("siragpt:session-expired", expired) }
 })
 it("preserves credentials when the cookie fallback is rejected by CSRF after a bearer 401", async () => {
  let calls = 0
  fetchMock.mockImplementation(async () => ++calls === 1 ? json(401, { error: "invalid_token" }) : json(403, { code: "csrf_invalid" }))
  expect(await api._tryRefresh()).toBe(false)
  expect(await api._tryRefresh()).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(localStorage.getItem("auth-token")).toBe("expired")
 })

 it.each([401, 403])("still clears a genuinely expired session after authentication rejection %s", async status => {
  fetchMock.mockImplementation(async () => json(status, { error: "session_expired" }))
  expect(await api._tryRefresh()).toBe(false)
  expect(localStorage.getItem("auth-token")).toBeNull()
  expect(await api._tryRefresh()).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(2)
 })

})
