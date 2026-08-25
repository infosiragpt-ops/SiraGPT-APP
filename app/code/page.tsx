import { redirect } from "next/navigation"

import { chatSearchToAgentsHome } from "@/lib/agents-home-path"

/**
 * `/code` is no longer a product surface. Computer + Empresas live
 * inside `/agentes`. Keep this module as a server redirect so stale
 * bookmarks and client navigations never paint a public /code page.
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

export default async function CodeRedirectPage({
  searchParams,
}: {
  searchParams?: Promise<Search> | Search
}) {
  const sp = flattenSearch(await Promise.resolve(searchParams || {}))
  redirect(chatSearchToAgentsHome(sp))
}
