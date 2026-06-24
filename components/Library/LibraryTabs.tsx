import React, { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/navigation';
import apiClient from '@/lib/api';
import {
    Download,
    Search,
    X,
    Music2,
    Mic,
    Globe,
    Smartphone,
    Play,
    ExternalLink,
    Sparkles,
} from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { ThinkingIndicator } from '@/components/ui/thinking-indicator';
import { projectsService, type Project } from '@/lib/projects-service';

type MediaType = 'image' | 'video' | 'audio' | 'music' | 'webapp' | 'mobileapp';

interface MediaItem {
    messageId: string;
    id?: string;
    chatId: string;
    timestamp: string;
    type: MediaType;
    url?: string;
    video_url?: string;
    download_url?: string;
    status?: string;
    prompt: string;
    filename?: string;
    aspect_ratio?: string;
    mime?: string;
    sizeBytes?: number;
    source?: string;
}

type FilterType = 'all' | MediaType;

// Tab order requested by the product: apps first, then video/image, then the
// audio family. "Todos" stays first as the catch-all view.
const TAB_ORDER: FilterType[] = ['all', 'webapp', 'mobileapp', 'video', 'image', 'music', 'audio'];

const TAB_LABELS: Record<FilterType, string> = {
    all: 'Todos',
    image: 'Imágenes',
    video: 'Videos',
    music: 'Música',
    audio: 'Audio',
    webapp: 'Apps web',
    mobileapp: 'Apps Móviles',
};

// Artifact-backed types load their bytes through an owner-scoped, token-auth'd
// endpoint, so they can't be rendered with a bare <audio>/<iframe> src — the
// modal fetches a Blob and renders via an object URL instead.
const ARTIFACT_TYPES: ReadonlySet<MediaType> = new Set(['audio', 'music', 'webapp', 'mobileapp']);

function isArtifactType(type: MediaType): boolean {
    return ARTIFACT_TYPES.has(type);
}

const TYPE_ICON: Record<MediaType, React.ReactNode> = {
    image: null,
    video: null,
    music: <Music2 className="w-7 h-7" />,
    audio: <Mic className="w-7 h-7" />,
    webapp: <Globe className="w-7 h-7" />,
    mobileapp: <Smartphone className="w-7 h-7" />,
};

const MediaLibrary: React.FC = () => {
    const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [filterType, setFilterType] = useState<FilterType>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [showModal, setShowModal] = useState(false);
    const [selectedMedia, setSelectedMedia] = useState<MediaItem | null>(null);
    // Object URL for the currently-open artifact (audio/music/webapp/mobileapp).
    const [artifactUrl, setArtifactUrl] = useState<string | null>(null);
    const [artifactLoading, setArtifactLoading] = useState(false);
    const [artifactError, setArtifactError] = useState<string | null>(null);
    // Web-app projects (created via "Proyecto en la nube" → tipo "App web").
    // Surfaced alongside chat-generated artifacts in the "Apps web" tab.
    const [webappProjects, setWebappProjects] = useState<Project[]>([]);
    const router = useRouter();

    const fetchMediaItems = async (page: number, typeFilter: FilterType) => {
        setLoading(true);
        setError(null);
        try {
            const params: { page: number; limit: number; type?: MediaType } = { page, limit: 20 };
            if (typeFilter !== 'all') {
                params.type = typeFilter;
            }
            const data = await apiClient.getMediaLibrary(params);
            setMediaItems(data.items);
            setCurrentPage(data.currentPage);
            setTotalPages(data.totalPages || 1);
        } catch (err: any) {
            setError(err.message || 'No se pudieron cargar los archivos');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchMediaItems(currentPage, filterType);
    }, [currentPage, filterType]);

    // Pull the user's "App web" projects for the webapp/all tabs. Failures
    // are non-fatal — the artifact grid still renders without them.
    useEffect(() => {
        if (filterType !== 'webapp' && filterType !== 'all') {
            setWebappProjects([]);
            return;
        }
        let cancelled = false;
        projectsService
            .list({ type: 'webapp', sort: 'activity' })
            .then((projects) => {
                if (!cancelled) setWebappProjects(projects);
            })
            .catch(() => {
                if (!cancelled) setWebappProjects([]);
            });
        return () => {
            cancelled = true;
        };
    }, [filterType]);

    // Apply the same client-side search to project cards.
    const visibleProjects = useMemo(() => {
        if (currentPage > 1) return [] as Project[]; // projects only on page 1
        const q = searchQuery.trim().toLowerCase();
        if (!q) return webappProjects;
        return webappProjects.filter((p) =>
            (p.name + ' ' + (p.description || '')).toLowerCase().includes(q)
        );
    }, [webappProjects, searchQuery, currentPage]);

    // Load the selected artifact's bytes (with auth) into an object URL so the
    // modal can play/preview it. Revokes the URL on close/change to avoid leaks.
    useEffect(() => {
        if (!selectedMedia || !isArtifactType(selectedMedia.type)) {
            return;
        }
        let cancelled = false;
        let objectUrl: string | null = null;
        const source = selectedMedia.download_url || selectedMedia.url || '';
        setArtifactLoading(true);
        setArtifactError(null);
        setArtifactUrl(null);
        apiClient
            .getMediaArtifactBlob(source)
            .then((blob) => {
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setArtifactUrl(objectUrl);
            })
            .catch((e: any) => {
                if (!cancelled) setArtifactError(e?.message || 'No se pudo cargar el archivo');
            })
            .finally(() => {
                if (!cancelled) setArtifactLoading(false);
            });
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [selectedMedia]);

    const handleNextPage = () => {
        if (currentPage < totalPages) setCurrentPage((prev) => prev + 1);
    };

    const handlePreviousPage = () => {
        if (currentPage > 1) setCurrentPage((prev) => prev - 1);
    };

    const handleTabChange = (type: FilterType) => {
        setFilterType(type);
        setCurrentPage(1);
    };

    const openMediaModal = (item: MediaItem) => {
        setSelectedMedia(item);
        setShowModal(true);
    };

    // Clicking a library item reopens the chat where it was created, so the
    // user lands back in the conversation they built it in. Items with no
    // originating chat (rare) fall back to the in-place preview modal.
    const handleItemClick = (item: MediaItem) => {
        if (item.chatId) {
            router.push(`/chat?id=${encodeURIComponent(item.chatId)}`);
            return;
        }
        openMediaModal(item);
    };

    const closeMediaModal = () => {
        setShowModal(false);
        setSelectedMedia(null);
        setArtifactUrl(null);
        setArtifactError(null);
        setArtifactLoading(false);
    };

    // Client-side prompt search across the current page's items. Keeps the
    // request count down (no per-keystroke API call) while still surfacing
    // matches the user can see at a glance.
    const visibleItems = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return mediaItems;
        return mediaItems.filter((item) =>
            ((item.prompt || '') + ' ' + (item.filename || '')).toLowerCase().includes(q)
        );
    }, [mediaItems, searchQuery]);

    const emptyMessage = useMemo(() => {
        if (searchQuery) return 'Ningún elemento coincide con tu búsqueda.';
        switch (filterType) {
            case 'image':
                return 'Aún no hay imágenes. ¡Genera una desde el chat!';
            case 'video':
                return 'Aún no hay videos. ¡Genera uno desde el chat!';
            case 'music':
                return 'Aún no hay música. Pide una canción en el chat (p. ej. “crea una canción lofi”).';
            case 'audio':
                return 'Aún no hay audio. Pide una narración o voz en el chat.';
            case 'webapp':
                return 'Aún no hay apps web. Genera una app o dashboard HTML desde el chat.';
            case 'mobileapp':
                return 'Aún no hay apps móviles.';
            default:
                return 'Aún no hay archivos. ¡Genera imágenes, videos, audio, música o apps!';
        }
    }, [filterType, searchQuery]);

    const renderArtifactCardBody = (item: MediaItem) => (
        <div className="flex flex-col items-center justify-center w-full h-full p-3 text-center gap-2">
            <div className="library-card-badge">{TYPE_ICON[item.type]}</div>
            <p className="library-card-title" title={item.filename || item.prompt}>
                {item.filename || item.prompt}
            </p>
            <span className="text-xs text-[hsl(var(--muted-foreground))]">{TAB_LABELS[item.type]}</span>
        </div>
    );

    return (
        <div className="library-page mx-auto w-full max-w-7xl px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-[calc(1.25rem+env(safe-area-inset-top))] sm:px-6 sm:pb-8 sm:pt-7 lg:px-8">
            <Head>
                <title>Biblioteca de archivos</title>
            </Head>
            <div className="library-header mb-5 flex items-start gap-3 sm:mb-6">
                <SidebarTrigger className="mt-1 md:hidden" />
                <div className="min-w-0">
                    <h1 className="library-title text-[1.85rem] leading-[1.04] sm:text-4xl">Tu biblioteca de archivos</h1>
                </div>
            </div>

            <div className="library-toolbar mb-5 sm:mb-7">
                <div className="library-tabs" role="tablist" aria-label="Filtrar biblioteca">
                    {TAB_ORDER.map((type) => {
                        const active = filterType === type;
                        return (
                            <button
                                key={type}
                                type="button"
                                role="tab"
                                aria-selected={active}
                                data-active={active}
                                onClick={() => handleTabChange(type)}
                                className="library-tab focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
                            >
                                {TAB_LABELS[type]}
                            </button>
                        );
                    })}
                </div>

                <div className="library-search" role="search">
                    <Search className="w-4 h-4 shrink-0 text-[hsl(var(--muted-foreground))] pointer-events-none" />
                    <label htmlFor="library-search-input" className="sr-only">
                        Buscar por prompt
                    </label>
                    <input
                        id="library-search-input"
                        type="search"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Buscar por prompt"
                        aria-label="Buscar elementos por prompt"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => setSearchQuery('')}
                            className="library-search-clear focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
                            aria-label="Limpiar búsqueda"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    )}
                </div>
            </div>

            {loading && <p className="text-gray-600 text-center py-10">Cargando archivos…</p>}
            {error && <p className="text-red-500 text-center py-10">Error: {error}</p>}

            <div className="library-grid grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 xl:grid-cols-5">
                {visibleProjects.map((project) => (
                    <div
                        key={`project-${project.id}`}
                        className="library-card group cursor-pointer aspect-square"
                        onClick={() => router.push(`/projects/${project.id}`)}
                        title={`Abrir proyecto: ${project.name}`}
                    >
                        <div className="flex flex-col items-center justify-center w-full h-full p-3 text-center gap-2">
                            <div className="library-card-badge"><Globe className="w-7 h-7" /></div>
                            <p className="library-card-title" title={project.name}>
                                {project.name}
                            </p>
                            <span className="text-xs text-[hsl(var(--muted-foreground))]">Proyecto · App web</span>
                        </div>
                    </div>
                ))}
                {visibleItems.length > 0 ? (
                    visibleItems.map((item) => (
                        <div
                            key={`${item.messageId}-${item.type}-${item.timestamp}`}
                            className="library-card group cursor-pointer aspect-square"
                            onClick={() => handleItemClick(item)}
                            title={item.chatId ? 'Abrir el chat donde se creó' : (item.prompt || item.filename)}
                        >
                            {item.type === 'image' && (
                                // eslint-disable-next-line @next/next/no-img-element -- generated images are arbitrary external/CDN URLs; next/image's loader/domain allow-list doesn't fit them.
                                <img
                                    src={item.url || '/placeholder.png'}
                                    alt={item.prompt || 'Imagen generada'}
                                    onError={(e) => {
                                        (e.currentTarget as HTMLImageElement).src = '/placeholder.svg';
                                    }}
                                    className="object-cover w-full h-full transition-transform duration-200 group-hover:scale-[1.02]"
                                />
                            )}

                            {item.type === 'video' && item.status === 'completed' && item.video_url && (
                                <div className="relative w-full h-full">
                                    <video
                                        src={`${process.env.NEXT_PUBLIC_API_URL}${item.video_url}`}
                                        className="object-cover w-full h-full transition-transform duration-200 group-hover:scale-[1.02] bg-black"
                                        muted
                                        playsInline
                                    />
                                    <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-20 pointer-events-none">
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            fill="white"
                                            viewBox="0 0 24 24"
                                            stroke="none"
                                            className="w-12 h-12 opacity-80"
                                        >
                                            <path d="M8 5v14l11-7z" />
                                        </svg>
                                    </div>
                                </div>
                            )}

                            {item.type === 'video' && item.status === 'processing' && (
                                <div className="w-full h-full bg-blue-50 flex items-center justify-center text-blue-600 text-center animate-pulse p-2">
                                    <span>
                                        Procesando video…
                                        <br />
                                        (Recarga en un momento)
                                    </span>
                                </div>
                            )}

                            {isArtifactType(item.type) && renderArtifactCardBody(item)}

                            {(item.type === 'audio' || item.type === 'music') && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/10 transition-colors pointer-events-none">
                                    <Play className="w-8 h-8 text-[hsl(var(--foreground))]/80 opacity-0 group-hover:opacity-100 transition-opacity" />
                                </div>
                            )}
                        </div>
                    ))
                ) : (
                    visibleProjects.length === 0 && !loading && (
                        <div className="col-span-full library-empty py-12 px-6 flex flex-col items-center gap-4 text-center">
                            <div className="library-empty-badge">
                                <Sparkles className="w-7 h-7" />
                            </div>
                            <p className="text-[hsl(var(--muted-foreground))] text-base max-w-md">
                                {emptyMessage}
                            </p>
                        </div>
                    )
                )}
            </div>

            {totalPages > 1 && (
                <div className="flex justify-center items-center mt-8 gap-4">
                    <button
                        onClick={handlePreviousPage}
                        disabled={currentPage <= 1 || loading}
                        className="px-5 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-zinc-700 dark:hover:bg-zinc-600 dark:text-gray-100 transition-colors"
                    >
                        Anterior
                    </button>
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Página {currentPage} de {totalPages}
                    </span>
                    <button
                        onClick={handleNextPage}
                        disabled={currentPage >= totalPages || loading}
                        className="px-5 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-zinc-700 dark:hover:bg-zinc-600 dark:text-gray-100 transition-colors"
                    >
                        Siguiente
                    </button>
                </div>
            )}

            {showModal && selectedMedia && (
                <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
                    <div className="relative bg-[#1e1e1e] rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden">
                        <button
                            onClick={closeMediaModal}
                            className="absolute top-3 right-3 text-white text-2xl font-bold bg-gray-700 bg-opacity-80 hover:bg-opacity-100 rounded-full w-10 h-10 flex items-center justify-center z-10 transition"
                            aria-label="Cerrar"
                        >
                            &times;
                        </button>

                        <div className="p-4 pt-12 text-white overflow-y-auto max-h-[90vh]">
                            {selectedMedia.type === 'image' && selectedMedia.url && (
                                // eslint-disable-next-line @next/next/no-img-element -- generated images are arbitrary external/CDN URLs; next/image's loader/domain allow-list doesn't fit them.
                                <img
                                    src={selectedMedia.url}
                                    alt={selectedMedia.prompt || 'Imagen generada'}
                                    className="max-w-full max-h-[calc(90vh-10rem)] object-contain mx-auto rounded-lg"
                                />
                            )}

                            {selectedMedia.type === 'video' && selectedMedia.status === 'completed' && selectedMedia.video_url && (
                                <video
                                    controls
                                    autoPlay
                                    src={`${process.env.NEXT_PUBLIC_API_URL}${selectedMedia.video_url}`}
                                    className="max-w-full max-h-[calc(90vh-10rem)] object-contain mx-auto bg-black rounded-lg"
                                >
                                    Tu navegador no admite la etiqueta de video.
                                </video>
                            )}

                            {selectedMedia.type === 'video' && selectedMedia.status === 'processing' && (
                                <div className="max-w-full max-h-[calc(90vh-10rem)] bg-blue-100 text-blue-700 flex items-center justify-center rounded-lg text-center p-4 animate-pulse">
                                    <span>
                                        Procesando el video…
                                        <br />
                                        (Vuelve más tarde)
                                    </span>
                                </div>
                            )}

                            {isArtifactType(selectedMedia.type) && (
                                <div className="min-h-[8rem]">
                                    {artifactLoading && (
                                        <div className="flex items-center justify-center gap-2 py-12 text-gray-300">
                                            <ThinkingIndicator size="md" />
                                            Cargando…
                                        </div>
                                    )}
                                    {artifactError && (
                                        <p className="text-red-400 text-center py-12">{artifactError}</p>
                                    )}

                                    {!artifactLoading && !artifactError && artifactUrl && (
                                        <>
                                            {(selectedMedia.type === 'audio' || selectedMedia.type === 'music') && (
                                                <div className="flex flex-col items-center gap-4 py-8">
                                                    <div className="text-blue-400">{TYPE_ICON[selectedMedia.type]}</div>
                                                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                                                    <audio controls autoPlay src={artifactUrl} className="w-full max-w-xl" />
                                                </div>
                                            )}

                                            {selectedMedia.type === 'webapp' && (
                                                <div className="flex flex-col gap-3">
                                                    <iframe
                                                        title={selectedMedia.filename || 'App web'}
                                                        src={artifactUrl}
                                                        className="w-full h-[60vh] bg-white rounded-lg border border-gray-700"
                                                        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
                                                    />
                                                    <button
                                                        onClick={() => window.open(artifactUrl, '_blank', 'noopener,noreferrer')}
                                                        className="inline-flex items-center justify-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition self-center"
                                                    >
                                                        <ExternalLink className="w-4 h-4" />
                                                        Abrir en nueva pestaña
                                                    </button>
                                                </div>
                                            )}

                                            {selectedMedia.type === 'mobileapp' && (
                                                <div className="flex flex-col items-center gap-4 py-10">
                                                    <div className="text-blue-400">{TYPE_ICON.mobileapp}</div>
                                                    <p className="text-gray-300 text-sm text-center">
                                                        Vista previa no disponible para apps móviles. Descarga el paquete para instalarlo.
                                                    </p>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}

                            <div className="mt-6 text-center">
                                <p className="text-xl font-semibold mb-2">{selectedMedia.prompt || selectedMedia.filename}</p>
                                <p className="text-sm text-gray-400">{new Date(selectedMedia.timestamp).toLocaleString()}</p>

                                {isArtifactType(selectedMedia.type) ? (
                                    artifactUrl && (
                                        <a
                                            href={artifactUrl}
                                            download={selectedMedia.filename || `artifact-${selectedMedia.id || selectedMedia.messageId}`}
                                            className="mt-4 inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition duration-200"
                                        >
                                            <Download className="w-5 h-5" />
                                            Descargar
                                        </a>
                                    )
                                ) : (
                                    selectedMedia.download_url && (
                                        <a
                                            href={selectedMedia.download_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            download={
                                                selectedMedia.filename ||
                                                `generated-${selectedMedia.type}-${selectedMedia.messageId}.${selectedMedia.type === 'image' ? 'png' : 'mp4'}`
                                            }
                                            className="mt-4 inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition duration-200"
                                        >
                                            <Download className="w-5 h-5" />
                                            Descargar {selectedMedia.type === 'image' ? 'imagen' : 'video'}
                                        </a>
                                    )
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default MediaLibrary;
