
// // components/Library/LibraryTabs.tsx
// import React, { useState, useEffect, useCallback } from 'react';
// import Image from 'next/image';
// import { ChevronRightIcon } from 'lucide-react';

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

//     const fetchLibraryItems = useCallback(async (type: 'images' | 'videos') => {
//         setLoading(true);
//         setError(null);
//         try {
//             const token = localStorage.getItem('auth-token');
//             if (!token) throw new Error('Please log in.');

//             const response = await fetch(`${API_BASE_URL}/api/library/${type}`, {
//                 headers: { Authorization: `Bearer ${token}` },
//             });

//             if (!response.ok) throw new Error(`Failed to fetch ${type}`);
//             const data: LibraryItem[] = await response.json();

//             type === 'images' ? setImages(data) : setVideos(data);
//         } catch (err: any) {
//             setError(err.message || `Failed to load ${type}`);
//         } finally {
//             setLoading(false);
//         }
//     }, [API_BASE_URL]);

//     useEffect(() => {
//         fetchLibraryItems('images');
//     }, [fetchLibraryItems]);

//     const handleTabClick = (tab: 'images' | 'videos') => {
//         setActiveTab(tab);
//         if (tab === 'images' && images.length === 0) fetchLibraryItems('images');
//         if (tab === 'videos' && videos.length === 0) fetchLibraryItems('videos');
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
//                 <p className="col-span-full text-center text-gray-600 dark:text-gray-300">
//                     No {type === 'image' ? 'images' : 'videos'} yet.
//                 </p>
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
//                                 ? 'border-b-2 border-blue-600 text-blue-600 dark:text-blue-400'
//                                 : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
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


// components/Library/LibraryTabs.tsx
import React, { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { ChevronRightIcon, ImageIcon, Video } from 'lucide-react';

interface LibraryItem {
    id: string;
    url: string;
    prompt: string;
    createdAt: string;
    chatTitle: string;
}

const LibraryTabs: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'images' | 'videos'>('images');
    const [images, setImages] = useState<LibraryItem[]>([]);
    const [videos, setVideos] = useState<LibraryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:5000';

    const fetchLibraryItems = useCallback(
        async (type: 'images' | 'videos') => {
            setLoading(true);
            setError(null);
            try {
                const token = localStorage.getItem('auth-token');
                if (!token) throw new Error('Please log in.');

                const response = await fetch(`${API_BASE_URL}/api/library/${type}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });

                if (!response.ok) throw new Error(`Failed to fetch ${type}`);
                const data: LibraryItem[] = await response.json();

                type === 'images' ? setImages(data) : setVideos(data);
            } catch (err: any) {
                setError(err.message || `Failed to load ${type}`);
            } finally {
                setLoading(false);
            }
        },
        [API_BASE_URL]
    );

    useEffect(() => {
        fetchLibraryItems('images');
    }, [fetchLibraryItems]);

    const handleTabClick = (tab: 'images' | 'videos') => {
        setActiveTab(tab);
        if (tab === 'images' && images.length === 0) fetchLibraryItems('images');
        if (tab === 'videos' && videos.length === 0) fetchLibraryItems('videos');
    };

    // Placeholder skeletons when no items
    const renderPlaceholders = (count: number, type: 'image' | 'video') => {
        return Array.from({ length: count }).map((_, i) => (
            <div
                key={`placeholder-${type}-${i}`}
                className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center aspect-square"
            >
                {type === 'image' ? (
                    <ImageIcon className="w-12 h-12 text-gray-400" />
                ) : (
                    <Video className="w-12 h-12 text-gray-400" />
                )}
                <p className="mt-2 text-sm text-gray-500">No {type} available</p>
            </div>
        ));
    };

    const renderGrid = (items: LibraryItem[], type: 'image' | 'video') => (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
            {items.length > 0 ? (
                items.map((item) => (
                    <div
                        key={item.id}
                        className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden hover:shadow-md transition"
                    >
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="block relative">
                            {type === 'image' ? (
                                <Image
                                    src={item.url}
                                    alt={item.prompt}
                                    width={500}
                                    height={500}
                                    className="w-full aspect-square object-cover hover:scale-105 transition-transform"
                                />
                            ) : (
                                <video
                                    controls
                                    src={item.url}
                                    className="w-full aspect-video object-cover hover:scale-105 transition-transform"
                                />
                            )}
                            <div className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 flex items-center justify-center transition">
                                <ChevronRightIcon className="w-8 h-8 text-white" />
                            </div>
                        </a>
                        <div className="p-3 text-sm">
                            <p className="text-gray-800 dark:text-gray-200 line-clamp-2 mb-1" title={item.prompt}>
                                {item.prompt}
                            </p>
                            <p className="text-gray-500 dark:text-gray-400 text-xs">
                                {new Date(item.createdAt).toLocaleDateString()} • {item.chatTitle}
                            </p>
                        </div>
                    </div>
                ))
            ) : (
                renderPlaceholders(0, type) // show 6 placeholders if empty
            )}
        </div>
    );

    return (
        <div className="px-6 py-6 max-w-7xl mx-auto">
            {/* Tabs */}
            <div className="flex gap-6 border-b border-gray-200 dark:border-gray-700 mb-6">
                {['images', 'videos'].map((tab) => (
                    <button
                        key={tab}
                        className={`pb-2 text-lg font-medium ${activeTab === tab
                            ? 'border-b-2 border-blue-600 text-blue-600 dark:text-blue-400'
                            : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                            }`}
                        onClick={() => handleTabClick(tab as 'images' | 'videos')}
                    >
                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </button>
                ))}
            </div>

            {loading && <p className="text-gray-600 dark:text-gray-300">Loading...</p>}
            {error && <p className="text-red-600 dark:text-red-400">Error: {error}</p>}

            {!loading && !error && (
                <>
                    {activeTab === 'images' && renderGrid(images, 'image')}
                    {activeTab === 'videos' && renderGrid(videos, 'video')}
                </>
            )}
        </div>
    );
};

export default LibraryTabs;
