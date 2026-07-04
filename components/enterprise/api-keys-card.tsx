"use client"

import * as React from "react"
import { Key, Copy, Check, Trash2, Eye, EyeOff } from "lucide-react"

interface ApiKey {
  id: string
  name: string
  prefix: string
  created_at: string
}

export function ApiKeysCard() {
  const [keys, setKeys] = React.useState<ApiKey[]>([])
  const [keyName, setKeyName] = React.useState("")
  const [newKey, setNewKey] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [showKey, setShowKey] = React.useState(false)

  React.useEffect(() => {
    fetchKeys()
  }, [])

  const fetchKeys = async () => {
    try {
      const res = await fetch("/api/keys")
      if (res.ok) {
        const data = await res.json()
        setKeys(data.keys || [])
      }
    } catch { /* silently ignore */ }
  }

  const createKey = async () => {
    if (!keyName.trim()) return
    setLoading(true)
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyName }),
      })
      if (res.ok) {
        const data = await res.json()
        setNewKey(data.key)
        setKeyName("")
        fetchKeys()
      }
    } finally {
      setLoading(false)
    }
  }

  const deleteKey = async (id: string) => {
    try {
      await fetch("/api/keys/" + id, { method: "DELETE" })
      fetchKeys()
    } catch { /* silently ignore */ }
  }

  const copyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="flex-1 p-6 space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-zinc-200">API Keys</h2>
        <p className="mt-1 text-sm text-zinc-500">Create and manage API keys for programmatic access to SiraGPT Agents.</p>
      </div>

      {newKey ? (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
          <p className="text-sm font-medium text-yellow-400">New API key created</p>
          <p className="mt-1 text-xs text-yellow-500/80">Save this key now — you won't see it again.</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 rounded bg-black/50 px-3 py-2 text-sm font-mono text-zinc-300 break-all">
              {showKey ? newKey : "sk_" + "*".repeat(newKey.length - 3)}
            </code>
            <button onClick={() => setShowKey(!showKey)} className="rounded p-2 text-zinc-400 hover:text-zinc-200 hover:bg-white/10">
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            <button onClick={copyKey} className="rounded p-2 text-zinc-400 hover:text-zinc-200 hover:bg-white/10">
              {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <button onClick={() => setNewKey(null)} className="mt-3 text-xs text-zinc-400 hover:text-zinc-200">
            Dismiss
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="Key name (e.g. production, staging)"
            className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/50"
          />
          <button
            onClick={createKey}
            disabled={loading || !keyName.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Key className="h-3.5 w-3.5" />
            {loading ? "Creating..." : "Create"}
          </button>
        </div>
      )}

      {keys.length > 0 ? (
        <div className="space-y-2">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
              <Key className="h-4 w-4 text-zinc-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-300 truncate">{k.name}</p>
                <code className="text-xs text-zinc-600">{k.prefix}...</code>
              </div>
              <span className="text-[10px] text-zinc-600">{k.created_at?.slice(0, 10)}</span>
              <button onClick={() => deleteKey(k.id)} className="rounded p-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-500/10">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-sm text-zinc-600">
          <Key className="h-8 w-8 mb-2 text-zinc-700" />
          No API keys yet. Create one to start using the SDK.
        </div>
      )}
    </div>
  )
}