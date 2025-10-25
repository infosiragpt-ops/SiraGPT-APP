"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { apiClient } from "@/lib/api"
import { toast } from "sonner"

export default function SpotifyConnectionCard() {
  const [isConnecting, setIsConnecting] = React.useState(false)
   const [isConnected, setIsConnected] = React.useState(false);

  // ✅ NAYA useEffect: Page load hone par status check karega
  React.useEffect(() => {
    const checkStatus = async () => {
      try {
        const response = await apiClient.getSpotifyStatus(); // Iske liye apiClient mein ek naya function banayenge
        setIsConnected(response.isConnected);
      } catch (error) {
        console.error("Could not check Spotify status:", error);
        setIsConnected(false);
      }
    };
    checkStatus();
  }, []); 

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      const response = await apiClient.getSpotifyAuthUrl()
      if (response.url) {
        window.location.href = response.url
      } else {
        toast.error("Could not get Spotify connection URL.")
      }
    } catch (error) {
      toast.error("Failed to connect to Spotify.")
      console.error("Spotify connection error:", error)
    } finally {
      setIsConnecting(false)
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Connect to Spotify</CardTitle>
        <CardDescription>
          Connect your Spotify account to allow the AI to search for songs, manage playlists, and more.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          By connecting, you agree to grant this application permission to access your Spotify data.
        </p>
      </CardContent>
      <CardFooter>
        <Button onClick={handleConnect} disabled={isConnecting}>
          {isConnecting ? "Connecting..." : "Connect to Spotify"}
        </Button>
      </CardFooter>
    </Card>
  )
}
