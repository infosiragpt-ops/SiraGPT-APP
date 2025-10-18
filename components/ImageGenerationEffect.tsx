"use client";

import React from 'react';
import { motion } from 'framer-motion';
import { ImageIcon, Loader2, Sparkles } from 'lucide-react';

const ImageGenerationEffect = () => {
    return (
        <div className="relative w-[300px] h-20 bg-gray-200 dark:bg-gray-800 rounded-lg flex items-center p-5 overflow-hidden">
            {/* <motion.div
                className="absolute inset-0 bg-gray-300 dark:bg-gray-700"
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
            />
            <div className="relative z-10 flex flex-col items-center text-white">
                <Sparkles className="w-12 h-12 mb-4" />
                <p className="font-semibold">Generating Image...</p>
            </div> */}
            <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating Image...
            </>
        </div>
    );
};

export default ImageGenerationEffect;
