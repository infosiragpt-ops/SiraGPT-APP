import { redirect } from "next/navigation"

import { chatSearchToAgentsHome } from "@/lib/agents-home-path"

/**
 * `/chat` is a compatibility alias. The agents home is `/`.
 * Query (including chat id) is preserved; the browser keeps the hash.
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

export default async function ChatRedirectPage({
  searchParams,
}: {
  searchParams?: Promise<Search> | Search
}) {
  const sp = flattenSearch(await Promise.resolve(searchParams || {}))
  redirect(chatSearchToAgentsHome(sp))
}
