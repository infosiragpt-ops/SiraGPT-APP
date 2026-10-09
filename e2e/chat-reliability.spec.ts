import { expect, test, type Page, type Route } from '@playwright/test'

test.use({ locale: 'es-PE' })
test.describe.configure({ timeout: 120_000 })
const user = { id: 'reliability-user', name: 'Prueba', email: 'fixture@example.com', plan: 'PRO', apiUsage: 0, monthlyLimit: 100000 }
const model = { id: 'reliability-model', name: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', provider: 'DeepSeek', type: 'TEXT', isActive: true }
const initial = { id: 'reliability-chat', title: 'Fiabilidad', model: model.name, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' }
async function setup(page: Page) {
  const messages: any[] = [{ id: 'source', chatId: initial.id, role: 'ASSISTANT', content: '| Nombre | Resultado |\n|---|---|\n| Alfa | 42 |', timestamp: initial.createdAt }]
  const state = { starts: 0, cancels: 0, assistantPosts: 0, runId: '', status: 'running', lastBody: {} as any, runReads: 0 }
  await page.addInitScript(() => { localStorage.setItem('auth-token', 'reliability-fixture'); localStorage.setItem('currentChatId', 'reliability-chat') })
  const json = (route: Route, value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) })
  const handle = async (route: Route) => {
    const request=route.request(), path=new URL(request.url()).pathname.replace(/^\/api(?=\/|$)/,'')
    if(path==='/auth/me') return json(route,{user})
    if(path==='/health') return json(route,{status:'healthy'})
    if(path==='/ai/models') return json(route,{models:[model]})
    if(path==='/payments/subscription') return json(route,{plan:'PRO',status:'active',apiUsage:0,monthlyLimit:100000})
    if(path==='/chats') return json(route,{chats:[{...initial,messages:[]}],pagination:{page:1,limit:20,total:1,pages:1}})
    if(path===`/chats/${initial.id}/messages` && request.method()==='POST') {
      const body=request.postDataJSON(); if(body.role==='ASSISTANT')state.assistantPosts++
      const message={...body,id:`saved-${messages.length}`,chatId:initial.id,timestamp:new Date().toISOString()};messages.push(message)
      return json(route,{message})
    }
    if(path===`/chats/${initial.id}`) return json(route,{chat:{...initial,messages}})
    if(path==='/research-agent/stream') {
      state.starts++;state.lastBody=request.postDataJSON();state.runId=state.lastBody.runId
      return route.fulfill({status:200,contentType:'text/event-stream',body:`data: ${JSON.stringify({type:'start',runId:state.runId,chatId:initial.id})}\n\n`})
    }
    if(path===`/research-agent/runs/${state.runId}/cancel`) { state.cancels++;state.status='cancelled';return json(route,{runId:state.runId,chatId:initial.id,status:state.status}) }
    if(path===`/research-agent/runs/${state.runId}`) { state.runReads++;return json(route,{runId:state.runId,chatId:initial.id,status:state.status}) }
    return json(route,{})
  }
  await page.route('**/api/**',handle);await page.route('http://localhost:5000/**',handle)
  await page.goto(`/agentes?id=${initial.id}`,{waitUntil:'domcontentloaded'})
  return state
}

test('expanded message table has one modal and returns focus after Escape',async({page})=>{
  await setup(page)
  await expect(page.getByRole('cell',{name:'Alfa'})).toBeVisible()
  await page.getByRole('table').hover()
  const expand=page.getByRole('button',{name:'Expandir tabla'});await expand.click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-modal','true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(expand).toBeFocused()
})

test('goal survives a browser reload and existing Stop waits for cancellation without duplicate turns',async({page})=>{
  const state=await setup(page)
  // Use the same textarea and send/Stop controls as normal chat.
  const textarea=page.locator('textarea:visible').first();await textarea.fill('/goal efectos del aprendizaje espaciado')
  await page.locator('button.composer-send-button:visible').first().click()
  await expect.poll(()=>state.starts).toBe(1)
  expect(state.lastBody.model).toBe(model.name)
  await expect(page.getByRole('button',{name:'Detener generación'})).toBeVisible()
  await page.reload({waitUntil:'domcontentloaded'})
  await expect(page.getByRole('button',{name:'Detener generación'})).toBeVisible()
  await page.getByRole('button',{name:'Detener generación'}).click()
  await expect.poll(()=>state.cancels).toBe(1)
  await expect(page.getByRole('button',{name:'Detener generación'})).toHaveCount(0)
  expect(state.starts).toBe(1);expect(state.assistantPosts).toBe(0)
  await expect(page.getByText('efectos del aprendizaje espaciado',{exact:true})).toBeVisible()
})
