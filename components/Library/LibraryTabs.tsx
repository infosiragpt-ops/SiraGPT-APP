
// // // components/Library/LibraryTabs.tsx
// // import React, { useState, useEffect, useCallback } from 'react';
// // import Image from 'next/image';
// // import { ChevronRightIcon } from 'lucide-react';

// // interface LibraryItem {
// //     id: string;
// //     url: string;
// //     prompt: string;
// //     createdAt: string;
// //     chatTitle: string;
// // }

// // const LibraryTabs: React.FC = () => {
// //     const [activeTab, setActiveTab] = useState<'images' | 'videos'>('images');
// //     const [images, setImages] = useState<LibraryItem[]>([]);
// //     const [videos, setVideos] = useState<LibraryItem[]>([]);
// //     const [loading, setLoading] = useState(true);
// //     const [error, setError] = useState<string | null>(null);

// //     const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:5000';

// //     const fetchLibraryItems = useCallback(async (type: 'images' | 'videos') => {
// //         setLoading(true);
// //         setError(null);
// //         try {
// //             const token = localStorage.getItem('auth-token');
// //             if (!token) throw new Error('Please log in.');

// //             const response = await fetch(`${API_BASE_URL}/api/library/${type}`, {
// //                 headers: { Authorization: `Bearer ${token}` },
// //             });

// //             if (!response.ok) throw new Error(`Failed to fetch ${type}`);
// //             const data: LibraryItem[] = await response.json();

// //             type === 'images' ? setImages(data) : setVideos(data);
// //         } catch (err: any) {
// //             setError(err.message || `Failed to load ${type}`);
// //         } finally {
// //             setLoading(false);
// //         }
// //     }, [API_BASE_URL]);

// //     useEffect(() => {
// //         fetchLibraryItems('images');
// //     }, [fetchLibraryItems]);

// //     const handleTabClick = (tab: 'images' | 'videos') => {
// //         setActiveTab(tab);
// //         if (tab === 'images' && images.length === 0) fetchLibraryItems('images');
// //         if (tab === 'videos' && videos.length === 0) fetchLibraryItems('videos');
// //     };

// //     const renderGrid = (items: LibraryItem[], type: 'image' | 'video') => (
// //         <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
// //             {items.length > 0 ? (
// //                 items.map((item) => (
// //                     <div
// //                         key={item.id}
// //                         className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden hover:shadow-md transition"
// //                     >
// //                         <a href={item.url} target="_blank" rel="noopener noreferrer" className="block relative">
// //                             {type === 'image' ? (
// //                                 <Image
// //                                     src={item.url}
// //                                     alt={item.prompt}
// //                                     width={500}
// //                                     height={500}
// //                                     className="w-full aspect-square object-cover hover:scale-105 transition-transform"
// //                                 />
// //                             ) : (
// //                                 <video
// //                                     controls
// //                                     src={item.url}
// //                                     className="w-full aspect-video object-cover hover:scale-105 transition-transform"
// //                                 />
// //                             )}
// //                             <div className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 flex items-center justify-center transition">
// //                                 <ChevronRightIcon className="w-8 h-8 text-white" />
// //                             </div>
// //                         </a>
// //                         <div className="p-3 text-sm">
// //                             <p className="text-gray-800 dark:text-gray-200 line-clamp-2 mb-1" title={item.prompt}>
// //                                 {item.prompt}
// //                             </p>
// //                             <p className="text-gray-500 dark:text-gray-400 text-xs">
// //                                 {new Date(item.createdAt).toLocaleDateString()} • {item.chatTitle}
// //                             </p>
// //                         </div>
// //                     </div>
// //                 ))
// //             ) : (
// //                 <p className="col-span-full text-center text-gray-600 dark:text-gray-300">
// //                     No {type === 'image' ? 'images' : 'videos'} yet.
// //                 </p>
// //             )}
// //         </div>
// //     );

// //     return (
// //         <div className="px-6 py-6 max-w-7xl mx-auto">
// //             {/* Tabs */}
// //             <div className="flex gap-6 border-b border-gray-200 dark:border-gray-700 mb-6">
// //                 {['images', 'videos'].map((tab) => (
// //                     <button
// //                         key={tab}
// //                         className={`pb-2 text-lg font-medium ${activeTab === tab
// //                                 ? 'border-b-2 border-blue-600 text-blue-600 dark:text-blue-400'
// //                                 : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
// //                             }`}
// //                         onClick={() => handleTabClick(tab as 'images' | 'videos')}
// //                     >
// //                         {tab.charAt(0).toUpperCase() + tab.slice(1)}
// //                     </button>
// //                 ))}
// //             </div>

// //             {loading && <p className="text-gray-600 dark:text-gray-300">Loading...</p>}
// //             {error && <p className="text-red-600 dark:text-red-400">Error: {error}</p>}

// //             {!loading && !error && (
// //                 <>
// //                     {activeTab === 'images' && renderGrid(images, 'image')}
// //                     {activeTab === 'videos' && renderGrid(videos, 'video')}
// //                 </>
// //             )}
// //         </div>
// //     );
// // };

// // export default LibraryTabs;


// // components/Library/LibraryTabs.tsx
// import React, { useState, useEffect, useCallback } from 'react';
// import Image from 'next/image';
// import { ChevronRightIcon, ImageIcon, Video } from 'lucide-react';

// interface LibraryItem {
//     id: string;
//     url: string;
//     prompt: string;
//     createdAt: string;
//     chatTitle: string;
// }

// const LibraryTabs: React.FC = () => {
//     const [activeTab, setActiveTab] = useState<'images' | 'videos'>('images');
//     const [images, setImages] = useState<LibraryItem[]>([]);
//     const [videos, setVideos] = useState<LibraryItem[]>([]);
//     const [loading, setLoading] = useState(true);
//     const [error, setError] = useState<string | null>(null);

//     const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:5000';

//     const fetchLibraryItems = useCallback(
//         async (type: 'images' | 'videos') => {
//             setLoading(true);
//             setError(null);
//             try {
//                 const token = localStorage.getItem('auth-token');
//                 if (!token) throw new Error('Please log in.');

//                 const response = await fetch(`${API_BASE_URL}/api/library/${type}`, {
//                     headers: { Authorization: `Bearer ${token}` },
//                 });

//                 if (!response.ok) throw new Error(`Failed to fetch ${type}`);
//                 const data: LibraryItem[] = await response.json();

//                 type === 'images' ? setImages(data) : setVideos(data);
//             } catch (err: any) {
//                 setError(err.message || `Failed to load ${type}`);
//             } finally {
//                 setLoading(false);
//             }
//         },
//         [API_BASE_URL]
//     );

//     useEffect(() => {
//         fetchLibraryItems('images');
//     }, [fetchLibraryItems]);

//     const handleTabClick = (tab: 'images' | 'videos') => {
//         setActiveTab(tab);
//         if (tab === 'images' && images.length === 0) fetchLibraryItems('images');
//         if (tab === 'videos' && videos.length === 0) fetchLibraryItems('videos');
//     };

//     // Placeholder skeletons when no items
//     const renderPlaceholders = (count: number, type: 'image' | 'video') => {
//         return Array.from({ length: count }).map((_, i) => (
//             <div
//                 key={`placeholder-${type}-${i}`}
//                 className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center aspect-square"
//             >
//                 {type === 'image' ? (
//                     <ImageIcon className="w-12 h-12 text-gray-400" />
//                 ) : (
//                     <Video className="w-12 h-12 text-gray-400" />
//                 )}
//                 <p className="mt-2 text-sm text-gray-500">No {type} available</p>
//             </div>
//         ));
//     };

//     const renderGrid = (items: LibraryItem[], type: 'image' | 'video') => (
//         <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
//             {items.length > 0 ? (
//                 items.map((item) => (
//                     <div
//                         key={item.id}
//                         className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden hover:shadow-md transition"
//                     >
//                         <a href={item.url} target="_blank" rel="noopener noreferrer" className="block relative">
//                             {type === 'image' ? (
//                                 <Image
//                                     src={item.url}
//                                     alt={item.prompt}
//                                     width={500}
//                                     height={500}
//                                     className="w-full aspect-square object-cover hover:scale-105 transition-transform"
//                                 />
//                             ) : (
//                                 <video
//                                     controls
//                                     src={item.url}
//                                     className="w-full aspect-video object-cover hover:scale-105 transition-transform"
//                                 />
//                             )}
//                             <div className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 flex items-center justify-center transition">
//                                 <ChevronRightIcon className="w-8 h-8 text-white" />
//                             </div>
//                         </a>
//                         <div className="p-3 text-sm">
//                             <p className="text-gray-800 dark:text-gray-200 line-clamp-2 mb-1" title={item.prompt}>
//                                 {item.prompt}
//                             </p>
//                             <p className="text-gray-500 dark:text-gray-400 text-xs">
//                                 {new Date(item.createdAt).toLocaleDateString()} • {item.chatTitle}
//                             </p>
//                         </div>
//                     </div>
//                 ))
//             ) : (
//                 renderPlaceholders(0, type) // show 6 placeholders if empty
//             )}
//         </div>
//     );

//     return (
//         <div className="px-6 py-6 max-w-7xl mx-auto">
//             {/* Tabs */}
//             <div className="flex gap-6 border-b border-gray-200 dark:border-gray-700 mb-6">
//                 {['images', 'videos'].map((tab) => (
//                     <button
//                         key={tab}
//                         className={`pb-2 text-lg font-medium ${activeTab === tab
//                             ? 'border-b-2 border-blue-600 text-blue-600 dark:text-blue-400'
//                             : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
//                             }`}
//                         onClick={() => handleTabClick(tab as 'images' | 'videos')}
//                     >
//                         {tab.charAt(0).toUpperCase() + tab.slice(1)}
//                     </button>
//                 ))}
//             </div>

//             {loading && <p className="text-gray-600 dark:text-gray-300">Loading...</p>}
//             {error && <p className="text-red-600 dark:text-red-400">Error: {error}</p>}

//             {!loading && !error && (
//                 <>
//                     {activeTab === 'images' && renderGrid(images, 'image')}
//                     {activeTab === 'videos' && renderGrid(videos, 'video')}
//                 </>
//             )}
//         </div>
//     );
// };

// export default LibraryTabs;


import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import apiClient from '@/lib/api';
import { Download } from 'lucide-react';

interface MediaItem {
    messageId: string;
    chatId: string;
    timestamp: string;
    type: 'image' | 'video';
    url?: string; // For images
    video_url?: string; // For videos (completed)
    download_url?: string; // For videos (completed)
    status?: string; // For videos (processing, completed)
    prompt: string;
    filename?: string; // For videos (during processing and completed)
    aspect_ratio?: string;
}

const MediaLibrary: React.FC = () => {
    const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [filterType, setFilterType] = useState<'all' | 'image' | 'video'>('all');
    const [showModal, setShowModal] = useState(false);
    const [selectedMedia, setSelectedMedia] = useState<MediaItem | null>(null);

    const fetchMediaItems = async (page: number, typeFilter: 'all' | 'image' | 'video') => {
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
            setError(err.message || 'Failed to fetch media items');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchMediaItems(currentPage, filterType);
    }, [currentPage, filterType]);

    const handleNextPage = () => {
        if (currentPage < totalPages) {
            setCurrentPage(prev => prev + 1);
        }
    };

    const handlePreviousPage = () => {
        if (currentPage > 1) {
            setCurrentPage(prev => prev - 1);
        }
    };

    const handleTabChange = (type: 'all' | 'image' | 'video') => {
        setFilterType(type);
        setCurrentPage(1); // Reset to first page on filter change
    };

    const openMediaModal = (item: MediaItem) => {
        setSelectedMedia(item);
        setShowModal(true);
    };

    const closeMediaModal = () => {
        setShowModal(false);
        setSelectedMedia(null);
    };

    return (
        <div className="container mx-auto p-4">
            <Head>
                <title>Media Library</title>
            </Head>
            <h1 className="text-3xl font-bold mb-6 text-gray-800">Your Media Library</h1>

            <div className="flex border-b border-gray-200 mb-6">
                <button
                    onClick={() => handleTabChange('all')}
                    className={`py-2 px-4 text-lg font-medium ${filterType === 'all' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-600 hover:text-gray-800'
                        } focus:outline-none transition-colors duration-200`}
                >
                    All
                </button>
                <button
                    onClick={() => handleTabChange('image')}
                    className={`py-2 px-4 text-lg font-medium ${filterType === 'image' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-600 hover:text-gray-800'
                        } focus:outline-none transition-colors duration-200`}
                >
                    Images
                </button>
                <button
                    onClick={() => handleTabChange('video')}
                    className={`py-2 px-4 text-lg font-medium ${filterType === 'video' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-600 hover:text-gray-800'
                        } focus:outline-none transition-colors duration-200`}
                >
                    Videos
                </button>
            </div>

            {loading && <p className="text-gray-600 text-center py-10">Loading media...</p>}
            {error && <p className="text-red-500 text-center py-10">Error: {error}</p>}

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                {mediaItems.length > 0 ? (
                    mediaItems.map((item) => (
                        <div
                            key={`${item.messageId}-${item.type}-${item.timestamp}`}
                            className="relative border border-gray-200 rounded-lg shadow-sm bg-white overflow-hidden group cursor-pointer aspect-w-1 aspect-h-1"
                            onClick={() => openMediaModal(item)}
                        >
                            {/* IMAGE */}
                            {item.type === 'image' && (
                                <img
                                    src={item.url || '/placeholder.png'}
                                    alt={item.prompt || 'Generated Image'}
                                    onError={(e) => {
                                        (e.currentTarget as HTMLImageElement).src = '/placeholder.svg';
                                    }}
                                    className="object-cover w-full h-full transition-transform duration-300 group-hover:scale-105"
                                />
                            )}

                            {/* VIDEO (COMPLETED) */}
                            {item.type === 'video' && item.status === 'completed' && item.video_url && (
                                <div className="relative w-full h-full">
                                    <video
                                        src={`${process.env.NEXT_PUBLIC_API_URL}${item.video_url}`}
                                        className="object-cover w-full h-full transition-transform duration-300 group-hover:scale-105 bg-black"
                                        muted
                                        playsInline
                                    />
                                    {/* Play icon overlay */}
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

                            {/* VIDEO (PROCESSING) */}
                            {item.type === 'video' && item.status === 'processing' && (
                                <div className="w-full h-full bg-blue-50 flex items-center justify-center text-blue-600 text-center animate-pulse p-2">
                                    <span>Video Processing...<br />(Refresh in a bit)</span>
                                </div>
                            )}

                            {/* DOWNLOAD ICON */}
                            {item.download_url && (item.type === 'video' || item.type === 'image') && (
                                <a
                                    href={item.download_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    download={item.filename || `generated-${item.type}-${item.messageId}.${item.type === 'image' ? 'png' : 'mp4'}`}
                                    className="absolute bottom-2 right-2 bg-black bg-opacity-60 text-white p-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10 hover:bg-opacity-80"
                                    title="Download"
                                >
                                    <Download className="w-5 h-5 text-white" />
                                </a>
                            )}
                        </div>
                    ))
                ) : (
                    !loading && (
                        <p className="col-span-full text-center text-gray-600 text-lg py-10">
                            No media items found. Generate some images or videos!
                        </p>
                    )
                )}

            </div>

            {/* <div className="flex justify-center items-center mt-8 space-x-4">
                <button
                    onClick={handlePreviousPage}
                    disabled={currentPage <= 1 || loading}
                    className="bg-blue-500 hover:bg-blue-600 text-white px-5 py-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
                >
                    Previous
                </button>
                <span className="text-xl font-medium text-gray-700">Page {currentPage} of {totalPages}</span>
                <button
                    onClick={handleNextPage}
                    disabled={currentPage >= totalPages || loading}
                    className="bg-blue-500 hover:bg-blue-600 text-white px-5 py-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
                >
                    Next
                </button>
            </div> */}

            {/* Media Modal */}
            {/* {showModal && selectedMedia && (
                <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
                    <div className="relative bg-white rounded-lg shadow-xl max-w-4xl max-h-[90vh] overflow-hidden">
                        <button
                            onClick={closeMediaModal}
                            className="absolute top-3 right-3 text-white text-3xl font-bold bg-gray-800 rounded-full w-10 h-10 flex items-center justify-center hover:bg-gray-700 transition-colors duration-200 z-10"
                        >
                            &times;
                        </button>
                        <div className="p-4 pt-10">
                            {selectedMedia.type === 'image' && selectedMedia.url && (
                                <img
                                    src={selectedMedia.url}
                                    alt={selectedMedia.prompt || 'Generated Image'}
                                    className="max-w-full max-h-[calc(90vh-8rem)] object-contain mx-auto"
                                />
                            )}
                            {selectedMedia.type === 'video' && selectedMedia.status === 'completed' && selectedMedia.video_url && (
                                <video
                                    controls
                                    autoPlay
                                    src={`${process.env.NEXT_PUBLIC_API_URL}${selectedMedia.video_url}`}
                                    className="max-w-full max-h-[calc(90vh-8rem)] object-contain mx-auto bg-black rounded-md"
                                >
                                    Your browser does not support the video tag.
                                </video>
                            )}
                            {selectedMedia.type === 'video' && selectedMedia.status === 'processing' && (
                                <div className="max-w-full max-h-[calc(90vh-8rem)] bg-blue-50 flex items-center justify-center rounded-md text-blue-600 text-center animate-pulse p-4">
                                    <span>Video Processing...<br />(Please close and check back later)</span>
                                </div>
                            )}
                            <div className="mt-4 text-center">
                                <p className="text-lg font-semibold text-gray-800 mb-2">{selectedMedia.prompt}</p>
                                <p className="text-sm text-gray-600">{new Date(selectedMedia.timestamp).toLocaleString()}</p>
                                {selectedMedia.download_url && (
                                    <a
                                        href={selectedMedia.download_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        download={selectedMedia.filename || `generated-${selectedMedia.type}-${selectedMedia.messageId}.${selectedMedia.type === 'image' ? 'png' : 'mp4'}`}
                                        className="mt-4 inline-block bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg text-md font-medium transition-colors duration-200"
                                    >
                                        Download {selectedMedia.type === 'image' ? 'Image' : 'Video'}
                                    </a>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )} */}
            {showModal && selectedMedia && (
                <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
                    <div className="relative bg-[#1e1e1e] rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden">
                        {/* Close Button */}
                        <button
                            onClick={closeMediaModal}
                            className="absolute top-3 right-3 text-white text-2xl font-bold bg-gray-700 bg-opacity-80 hover:bg-opacity-100 rounded-full w-10 h-10 flex items-center justify-center z-10 transition"
                            aria-label="Close"
                        >
                            &times;
                        </button>

                        <div className="p-4 pt-12 text-white">
                            {/* Image */}
                            {selectedMedia.type === 'image' && selectedMedia.url && (
                                <img
                                    src={selectedMedia.url}
                                    alt={selectedMedia.prompt || 'Generated Image'}
                                    className="max-w-full max-h-[calc(90vh-10rem)] object-contain mx-auto rounded-lg"
                                />
                            )}

                            {/* Video */}
                            {selectedMedia.type === 'video' && selectedMedia.status === 'completed' && selectedMedia.video_url && (
                                <video
                                    controls
                                    autoPlay
                                    src={`${process.env.NEXT_PUBLIC_API_URL}${selectedMedia.video_url}`}
                                    className="max-w-full max-h-[calc(90vh-10rem)] object-contain mx-auto bg-black rounded-lg"
                                >
                                    Your browser does not support the video tag.
                                </video>
                            )}

                            {/* Processing Placeholder */}
                            {selectedMedia.type === 'video' && selectedMedia.status === 'processing' && (
                                <div className="max-w-full max-h-[calc(90vh-10rem)] bg-blue-100 text-blue-700 flex items-center justify-center rounded-lg text-center p-4 animate-pulse">
                                    <span>Video Processing...<br />(Please check back later)</span>
                                </div>
                            )}

                            {/* Info & Download */}
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
                                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-5 h-5">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75v2.25A2.25 2.25 0 006.75 20.25h10.5a2.25 2.25 0 002.25-2.25v-2.25M12 3v12m0 0l-3.75-3.75M12 15l3.75-3.75" />
                                        </svg>
                                        Download {selectedMedia.type === 'image' ? 'Image' : 'Video'}
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