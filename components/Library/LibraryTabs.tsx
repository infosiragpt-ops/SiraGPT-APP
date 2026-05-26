import React, { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import apiClient from '@/lib/api';
import { Download, Search } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';

interface MediaItem {
    messageId: string;
    chatId: string;
    timestamp: string;
    type: 'image' | 'video';
    url?: string;
    video_url?: string;
    download_url?: string;
    status?: string;
    prompt: string;
    filename?: string;
    aspect_ratio?: string;
}

type FilterType = 'all' | 'image' | 'video';

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

    const fetchMediaItems = async (page: number, typeFilter: FilterType) => {
        setLoading(true);
        setError(null);
        try {
            const params: { page: number; limit: number; type?: 'image' | 'video' } = { page, limit: 20 };
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

    const closeMediaModal = () => {
        setShowModal(false);
        setSelectedMedia(null);
    };

    // Client-side prompt search across the current page's items. Keeps the
    // request count down (no per-keystroke API call) while still surfacing
    // matches the user can see at a glance.
    const visibleItems = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return mediaItems;
        return mediaItems.filter((item) => (item.prompt || '').toLowerCase().includes(q));
    }, [mediaItems, searchQuery]);

    return (
        <div className="container mx-auto p-4">
            <Head>
                <title>Biblioteca de archivos</title>
            </Head>
            <div className="flex items-center gap-3 mb-6">
                <SidebarTrigger className="md:hidden" />
                <h1 className="text-3xl font-bold text-gray-800 dark:text-white">Tu biblioteca de archivos</h1>
            </div>

            <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex border-b border-gray-200 dark:border-gray-700">
                    {(['all', 'image', 'video'] as const).map((type) => {
                        const labels: Record<FilterType, string> = {
                            all: 'Todos',
                            image: 'Imágenes',
                            video: 'Videos',
                        };
                        const active = filterType === type;
                        return (
                            <button
                                key={type}
                                onClick={() => handleTabChange(type)}
                                className={`py-2 px-4 text-lg font-medium transition-colors duration-200 focus:outline-none ${
                                    active
                                        ? 'border-b-2 border-blue-600 text-blue-600'
                                        : 'text-gray-600 hover:text-gray-800 dark:text-gray-300'
                                }`}
                            >
                                {labels[type]}
                            </button>
                        );
                    })}
                </div>

                <label className="relative flex items-center w-full sm:w-72">
                    <Search className="absolute left-3 w-4 h-4 text-gray-400 pointer-events-none" />
                    <input
                        type="search"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Buscar por prompt…"
                        className="w-full pl-9 pr-3 py-2 text-sm rounded-md border border-gray-200 bg-white dark:bg-zinc-800 dark:border-gray-700 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        aria-label="Buscar elementos por prompt"
                    />
                </label>
            </div>

            {loading && <p className="text-gray-600 text-center py-10">Cargando archivos…</p>}
            {error && <p className="text-red-500 text-center py-10">Error: {error}</p>}

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                {visibleItems.length > 0 ? (
                    visibleItems.map((item) => (
                        <div
                            key={`${item.messageId}-${item.type}-${item.timestamp}`}
                            className="relative border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm bg-white dark:bg-zinc-800 overflow-hidden group cursor-pointer aspect-w-1 aspect-h-1"
                            onClick={() => openMediaModal(item)}
                        >
                            {item.type === 'image' && (
                                <img
                                    src={item.url || '/placeholder.png'}
                                    alt={item.prompt || 'Imagen generada'}
                                    onError={(e) => {
                                        (e.currentTarget as HTMLImageElement).src = '/placeholder.svg';
                                    }}
                                    className="object-cover w-full h-full transition-transform duration-300 group-hover:scale-105"
                                />
                            )}

                            {item.type === 'video' && item.status === 'completed' && item.video_url && (
                                <div className="relative w-full h-full">
                                    <video
                                        src={`${process.env.NEXT_PUBLIC_API_URL}${item.video_url}`}
                                        className="object-cover w-full h-full transition-transform duration-300 group-hover:scale-105 bg-black"
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

                            {item.download_url && (
                                <a
                                    href={item.download_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    download={item.filename || `generated-${item.type}-${item.messageId}.${item.type === 'image' ? 'png' : 'mp4'}`}
                                    className="absolute bottom-2 right-2 bg-black bg-opacity-60 text-white p-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10 hover:bg-opacity-80"
                                    title="Descargar"
                                    aria-label="Descargar archivo"
                                >
                                    <Download className="w-5 h-5 text-white" />
                                </a>
                            )}
                        </div>
                    ))
                ) : (
                    !loading && (
                        <p className="col-span-full text-center text-gray-600 dark:text-gray-300 text-lg py-10">
                            {searchQuery
                                ? 'Ningún elemento coincide con tu búsqueda.'
                                : 'Aún no hay archivos. ¡Genera imágenes o videos!'}
                        </p>
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

                        <div className="p-4 pt-12 text-white">
                            {selectedMedia.type === 'image' && selectedMedia.url && (
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

                            <div className="mt-6 text-center">
                                <p className="text-xl font-semibold mb-2">{selectedMedia.prompt}</p>
                                <p className="text-sm text-gray-400">{new Date(selectedMedia.timestamp).toLocaleString()}</p>

                                {selectedMedia.download_url && (
                                    <a
                                        href={selectedMedia.download_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        download={selectedMedia.filename || `generated-${selectedMedia.type}-${selectedMedia.messageId}.${selectedMedia.type === 'image' ? 'png' : 'mp4'}`}
                                        className="mt-4 inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition duration-200"
                                    >
                                        <Download className="w-5 h-5" />
                                        Descargar {selectedMedia.type === 'image' ? 'imagen' : 'video'}
                                    </a>
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
