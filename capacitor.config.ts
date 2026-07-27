import type { CapacitorConfig } from "@capacitor/cli"

const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim() || "https://siragpt.com/chat"
const isCleartextDevelopmentServer = serverUrl.startsWith("http://")

const config: CapacitorConfig = {
  appId: "com.siragpt.app",
  appName: "Sira GPT",
  webDir: "mobile-www",
  server: {
    url: serverUrl,
    cleartext: isCleartextDevelopmentServer,
    allowNavigation: ["siragpt.com", "www.siragpt.com"],
  },
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
  },
  android: {
    minWebViewVersion: 60,
  },
}

export default config
