import { redirect } from "next/navigation"

import { agentsHomeHref } from "@/lib/agents-home-path"

/**
 * `/chat/:id` is a compatibility alias of `/agentes/:id`.
 * The product noun is «agentes», not «chat».
 */
type Search = Record<string, string | string[] | undefined>

function flattenSearch(searchParams: Search | undefined): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null && item !== "") params.append(key, String(item))
      }
    } else if (value != null && value !== "") {
      params.set(key, String(value))
    }
  }
  return params
}

export default async function ChatIdRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<Search>
}) {
  const resolved = await Promise.resolve(params)
  const sp = flattenSearch(await Promise.resolve(searchParams || {}))
  redirect(agentsHomeHref(sp, null, resolved.id))
}
