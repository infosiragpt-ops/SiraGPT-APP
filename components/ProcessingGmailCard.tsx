"use client";
import { useEffect, useState } from "react";

export default function ProcessingGmailCard() {
  const stages = [
    "Connecting to Gmail securely...",
    "Syncing inbox data...",
    "Analyzing messages...",
    "Almost done...",
  ];
  const [stage, setStage] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (stage < stages.length - 1) {
      const interval = setInterval(() => {
        setStage((prev) => {
          if (prev < stages.length - 1) return prev + 1;
          clearInterval(interval);
          setDone(true);
          return prev;
        });
      }, 3500);
      return () => clearInterval(interval);
    } else {
      setDone(true);
    }
    // stages.length is a constant in this component (defined in module
    // scope) — adding it would be noise without changing behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const colorMap = [
    "from-blue-500 to-indigo-500",
    "from-indigo-500 to-purple-500",
    "from-purple-500 to-pink-500",
    "from-green-500 to-emerald-500",
  ];

  return (
    <div
      className="relative mt-4 inline-flex items-center gap-4 px-6 py-5 rounded-2xl
      border border-blue-100 dark:border-blue-900/60
      bg-gradient-to-br from-white/95 via-white/90 to-slate-50/80 
      dark:from-[#0b1120] dark:via-[#0f172a] dark:to-[#1e293b]
      shadow-[0_4px_25px_rgba(0,0,0,0.08)]
      dark:shadow-[0_0_25px_rgba(59,130,246,0.35)]
      backdrop-blur-xl transition-all duration-500 ease-out
      hover:shadow-[0_8px_28px_rgba(59,130,246,0.15)]
      dark:hover:shadow-[0_0_40px_rgba(59,130,246,0.45)]
      hover:scale-[1.02]
      overflow-hidden min-h-[90px] min-w-[260px]"
    >
      {/* Animated Orb */}
      <div className="relative flex items-center justify-center">
        <div
          className={`w-12 h-12 rounded-full bg-gradient-to-tr ${colorMap[stage]} ${
            done ? "animate-glow" : "animate-pulse"
          } shadow-[0_0_25px_rgba(59,130,246,0.3)] dark:shadow-[0_0_40px_rgba(59,130,246,0.5)] transition-all duration-1000`}
        >
          {/* Inner reflection */}
          <div className="absolute inset-[3px] rounded-full bg-gradient-to-b from-white/60 to-transparent blur-[2px] dark:from-white/20" />
          {/* Outer halo */}
          <div className="absolute -inset-1 rounded-full bg-gradient-to-r from-white/60 to-transparent blur-lg opacity-40 animate-ping" />
        </div>

        {/* Gmail Icon */}
        <div className="absolute flex items-center justify-center">
          <svg
            className="w-5 h-5 text-white drop-shadow-[0_2px_2px_rgba(0,0,0,0.2)] animate-bounce-smooth"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              d="M20 4H4a2 2 0 00-2 2v12a2 
                     2 0 002 2h16a2 2 0 002-2V6a2 
                     2 0 00-2-2zm0 4l-8 5-8-5V6l8 
                     5 8-5v2z"
            />
          </svg>
        </div>
      </div>

      {/* Text Section */}
      <div className="flex flex-col min-w-[220px]">
        <div className="flex items-center gap-2">
          <span
            className="text-sm font-semibold bg-gradient-to-r 
            from-blue-700 via-purple-700 to-pink-600 
            dark:from-blue-300 dark:via-purple-400 dark:to-pink-300 
            bg-clip-text text-transparent"
          >
            Processing Gmail
          </span>
          {!done && (
            <div className="flex gap-1">
              <div
                className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce"
                style={{ animationDelay: "0ms" }}
              />
              <div
                className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce"
                style={{ animationDelay: "150ms" }}
              />
              <div
                className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce"
                style={{ animationDelay: "300ms" }}
              />
            </div>
          )}
        </div>

        <span
          key={stage}
          className="text-xs text-slate-700/90 dark:text-blue-200/80 mt-1 transition-opacity duration-700 ease-in-out opacity-100"
        >
          {stages[stage]}
        </span>
      </div>

      {/* Subtle particles */}
      <div className="absolute -top-2 left-3 w-2 h-2 bg-blue-400/70 rounded-full blur-[1px] animate-ping" />
      <div className="absolute bottom-2 right-2 w-1.5 h-1.5 bg-pink-400/70 rounded-full animate-pulse" />
      <div className="absolute top-1 right-1 w-[3px] h-[3px] bg-purple-400/70 rounded-full animate-bounce-smooth" />

      {!done && (
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-blue-300/10 to-transparent dark:via-blue-400/10 animate-wave" />
      )}
    </div>
  );
}
