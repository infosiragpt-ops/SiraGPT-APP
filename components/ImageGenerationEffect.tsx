// "use client";

// import React from 'react';
// import { motion } from 'framer-motion';
// import { ImageIcon, Loader2, Sparkles } from 'lucide-react';

// const ImageGenerationEffect = () => {
//     return (
//         <div className="relative w-[300px] h-20 bg-gray-200 dark:bg-gray-800 rounded-lg flex items-center justify-center p-5 overflow-hidden">
//             <motion.div
//                 className="absolute inset-0 bg-gray-300 dark:bg-gray-700"
//                 animate={{ opacity: [0.5, 1, 0.5] }}
//                 transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
//             />
//             <div className="relative z-10 flex flex-col items-center text-gray-700 dark:text-gray-200">
//                 <Sparkles className="w-8 h-8 mb-2" />
//                 <p className="font-semibold text-sm">Generating Image...</p>
//             </div>
//         </div>
//     );
// };

// export default ImageGenerationEffect;
"use client";

import React from "react";
import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

const ImageGenerationEffect = () => {
    return (
        <div className="relative w-[300px] h-[400px] bg-gradient-to-br from-gray-100 to-gray-300 dark:from-gray-800 dark:to-gray-700 rounded-xl shadow-md flex flex-col items-center justify-center overflow-hidden p-6">

            {/* Shimmer animation */}
            <motion.div
                className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent dark:via-white/10"
                animate={{ x: ['-100%', '100%'] }}
                transition={{ duration: 2.5, repeat: Infinity, ease: 'linear' }}
            />

            {/* Floating sparkles */}
            {[...Array(5)].map((_, i) => (
                <motion.div
                    key={i}
                    className="absolute text-yellow-400 text-sm"
                    initial={{ opacity: 0, y: 0 }}
                    animate={{ opacity: [0, 1, 0], y: [-5, -15, -5] }}
                    transition={{
                        duration: 3 + Math.random() * 1.5,
                        repeat: Infinity,
                        delay: i * 0.5,
                        ease: 'easeInOut',
                    }}
                    style={{
                        top: `${20 + Math.random() * 60}%`,
                        left: `${10 + Math.random() * 80}%`,
                    }}
                >
                    ✨
                </motion.div>
            ))}

            {/* Content */}
            <div className="relative z-10 flex flex-col items-center text-gray-700 dark:text-gray-200">
                <motion.div
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                >
                    <Sparkles className="w-10 h-10 mb-3 text-yellow-500" />
                </motion.div>
                <p className="font-semibold text-base">Generating your image...</p>
                <motion.p
                    className="text-sm mt-2 text-gray-600 dark:text-gray-400 text-center max-w-xs"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 1, 0.9, 1] }}
                    transition={{ duration: 3, repeat: Infinity }}
                >
                    This may take 2 to 3 minutes. Thank you for your patience! ✨
                </motion.p>
            </div>
        </div>
    );
};

export default ImageGenerationEffect;
