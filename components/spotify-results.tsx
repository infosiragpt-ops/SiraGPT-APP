"use client"

import { Card } from "@/components/ui/card"

interface SpotifyResultsProps {
    data: any
}

export default function SpotifyResults({ data }: SpotifyResultsProps) {
    if (!data) return null

    const openSpotifyLink = (url: string) => {
        if (url) {
            window.open(url, "_blank", "noopener,noreferrer")
        }
    }

    // Handle different types of Spotify data
    if (data.tracks && Array.isArray(data.tracks)) {
        const validTracks = data.tracks.filter((track: any) => track && track.name)

        if (validTracks.length === 0) {
            return <p className="text-slate-400 text-sm">No tracks found</p>
        }

        const title = data.type === 'history' ? "Recently Played:" : "Found Tracks:";

        return (
            <div className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-300 mb-3">{title}</h3>
                {validTracks.map((track: any, idx: number) => (
                    <Card
                        key={idx}
                        onClick={() => openSpotifyLink(track.external_urls?.spotify)}
                        className="bg-slate-700 p-3 hover:bg-slate-600 transition cursor-pointer"
                    >
                        <div className="flex items-start gap-3">
                            {track.album && track.album.images && track.album.images.length > 0 && track.album.images[0]?.url && (
                                <img
                                    src={track.album.images[0].url || "/placeholder.svg"}
                                    alt={track.name || "Track"}
                                    className="w-12 h-12 rounded object-cover"
                                />
                            )}
                            <div className="flex-1 min-w-0">
                                <p className="font-semibold text-white truncate">{track.name || "Unknown Track"}</p>
                                <p className="text-sm text-slate-400 truncate">
                                    {track.artists && Array.isArray(track.artists) && track.artists.length > 0
                                        ? track.artists.map((a: any) => a?.name || "Unknown").join(", ")
                                        : "Unknown Artist"}
                                </p>
                                <p className="text-xs text-slate-500 mt-1">Album: {track.album?.name || "Unknown"}</p>
                            </div>
                        </div>
                    </Card>
                ))}
            </div>
        )
    }

    if (data.artists && Array.isArray(data.artists)) {
        const validArtists = data.artists.filter((artist: any) => artist && artist.name)

        if (validArtists.length === 0) {
            return <p className="text-slate-400 text-sm">No artists found</p>
        }

        return (
            <div className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-300 mb-3">Found Artists:</h3>
                {validArtists.map((artist: any, idx: number) => (
                    <Card
                        key={idx}
                        onClick={() => openSpotifyLink(artist.external_urls?.spotify)}
                        className="bg-slate-700 p-3 hover:bg-slate-600 transition cursor-pointer"
                    >
                        <div className="flex items-start gap-3">
                            {artist.images && Array.isArray(artist.images) && artist.images.length > 0 && artist.images[0]?.url && (
                                <img
                                    src={artist.images[0].url || "/placeholder.svg"}
                                    alt={artist.name || "Artist"}
                                    className="w-12 h-12 rounded-full object-cover"
                                />
                            )}
                            <div className="flex-1">
                                <p className="font-semibold text-white">{artist.name || "Unknown Artist"}</p>
                                <p className="text-sm text-slate-400">
                                    Followers: {artist.followers?.total ? artist.followers.total.toLocaleString() : "N/A"}
                                </p>
                            </div>
                        </div>
                    </Card>
                ))}
            </div>
        )
    }

    if (data.playlists && Array.isArray(data.playlists)) {
        const validPlaylists = data.playlists.filter((playlist: any) => playlist && playlist.name)

        if (validPlaylists.length === 0) {
            return <p className="text-slate-400 text-sm">No playlists found</p>
        }

        return (
            <div className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-300 mb-3">Found Playlists:</h3>
                {validPlaylists.map((playlist: any, idx: number) => (
                    <Card
                        key={idx}
                        onClick={() => openSpotifyLink(playlist.external_urls?.spotify)}
                        className="bg-slate-700 p-3 hover:bg-slate-600 transition cursor-pointer"
                    >
                        <div className="flex items-start gap-3">
                            {playlist.images &&
                                Array.isArray(playlist.images) &&
                                playlist.images.length > 0 &&
                                playlist.images[0]?.url && (
                                    <img
                                        src={playlist.images[0].url || "/placeholder.svg"}
                                        alt={playlist.name || "Playlist"}
                                        className="w-12 h-12 rounded object-cover"
                                    />
                                )}
                            <div className="flex-1">
                                <p className="font-semibold text-white">{playlist.name || "Unknown Playlist"}</p>
                                <p className="text-sm text-slate-400">{playlist.tracks?.total || 0} tracks</p>
                            </div>
                        </div>
                    </Card>
                ))}
            </div>
        )
    }

    return null
}
