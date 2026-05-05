"use client"

import { AnimatePresence, motion } from "framer-motion"
import { useEffect, useState, useCallback, type CSSProperties } from "react"

/**
 * Brand showcase cycling through AI providers + feature demos.
 * Phases per slide:
 *   1. Loader bars (≈1.2s)
 *   2. Typewriter tagline (55ms/char + 0.3s hold)
 *   3. Display — tagline + visual settled (≈2.4s)
 *   4. Cinematic exit — scale up + blur + fade (≈0.7s)
 *
 * Layout: tagline anchored TOP of the card, visual centered vertically.
 */

// ========================= LLM LOGO MARKS =========================

const ClaudeVisual = ({ color }: { color: string }) => (
  <svg viewBox="0 0 1200 1200" xmlns="http://www.w3.org/2000/svg" className="h-[200px] w-[200px] md:h-[340px] md:w-[340px] lg:h-[400px] lg:w-[400px]">
    <motion.path
      fill={color}
      initial={{ pathLength: 0, opacity: 0 }}
      animate={{ pathLength: 1, opacity: 1 }}
      transition={{ duration: 1.1, ease: "easeOut" }}
      d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"
    />
  </svg>
)

const ChatGPTVisual = ({ color }: { color: string }) => (
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="h-[180px] w-[180px] md:h-[300px] md:w-[300px] lg:h-[340px] lg:w-[340px]">
    <motion.path
      fill={color}
      initial={{ pathLength: 0, opacity: 0 }}
      animate={{ pathLength: 1, opacity: 1 }}
      transition={{ duration: 1.1, ease: "easeOut" }}
      d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804L15.2559 17.6a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.0804.0804 0 0 1 .038.0615v5.5826a4.504 4.504 0 0 1-4.4944 4.4944zM3.6086 15.954a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.072.072 0 0 1-.0284.0615L9.6025 17.614a4.4992 4.4992 0 0 1-6.0006-1.6601zM2.3464 7.8964a4.4944 4.4944 0 0 1 2.3655-1.9728V11.6c-.0005.2759.1452.5315.3879.6765l5.8144 3.3543-2.02 1.1638a.0757.0757 0 0 1-.071 0l-4.8303-2.7866a4.504 4.504 0 0 1-1.6465-6.1479zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.3927-.6813zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0615V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6067 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
    />
  </svg>
)

const GeminiVisual = () => (
  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" className="h-[190px] w-[190px] md:h-[320px] md:w-[320px] lg:h-[360px] lg:w-[360px]">
    <defs>
      <linearGradient id="geminiGradCycle" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#ef4444" />
        <stop offset="33%" stopColor="#facc15" />
        <stop offset="66%" stopColor="#22c55e" />
        <stop offset="100%" stopColor="#3b82f6" />
      </linearGradient>
    </defs>
    <motion.path
      d="M50 4 C 54 32 62 42 96 50 C 62 58 54 68 50 96 C 46 68 38 58 4 50 C 38 42 46 32 50 4 Z"
      fill="url(#geminiGradCycle)"
      initial={{ pathLength: 0, opacity: 0, scale: 0.9 }}
      animate={{ pathLength: 1, opacity: 1, scale: 1 }}
      transition={{ duration: 1, ease: "easeOut" }}
      style={{ transformOrigin: "50% 50%" }}
    />
  </svg>
)

const GrokVisual = ({ color }: { color: string }) => (
  <svg viewBox="0 0 2000 1920" xmlns="http://www.w3.org/2000/svg" className="h-[180px] w-[180px] md:h-[300px] md:w-[300px] lg:h-[340px] lg:w-[340px]">
    <motion.g
      fill={color}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.9, ease: "easeOut" }}
      style={{ transformOrigin: "50% 50%" }}
    >
      <path d="M1997.505,5.546c-1.276,1.84-2.543,3.686-3.831,5.517c-44.395,63.091-89.508,125.693-132.964,189.424c-35.057,51.414-65.323,105.683-89.053,163.428c-34.447,83.828-47.232,171.046-42.05,261.249c3.355,58.404,12.861,115.859,25.887,172.786c16.297,71.216,24.256,143.247,20.188,216.29c-10.123,181.765-76.927,339.812-201.209,472.789c-107.86,115.406-239.56,189.915-394.446,221.624c-157.969,32.34-310.586,13.132-457.667-52.146c-43.51-19.311-84.795-42.677-124.218-69.344c-1.094-0.74-2.147-1.54-3.745-2.692c1.543-0.883,2.689-1.656,3.927-2.231c72.526-33.658,145.071-67.276,217.555-101.023c3.285-1.53,5.91-1.054,8.984,0.124c74.663,28.608,151.849,42.899,231.896,39.624c123.328-5.045,232.105-47.967,325.71-128.201c99.013-84.869,160.993-191.673,184.036-320.194c18.823-104.981,7.281-207.124-32.8-305.964c-13.942-34.381-52.565-47.733-86.226-30.057c-4.108,2.157-7.994,4.818-11.734,7.582c-216.828,160.265-433.63,320.565-650.436,480.86c-1.834,1.356-3.69,2.684-5.536,4.025c-0.344-0.374-0.689-0.747-1.033-1.121C1184.605,820.085,1590.468,412.274,1996.331,4.463C1996.722,4.824,1997.114,5.185,1997.505,5.546z" />
      <path d="M635.931,1353.173C425.433,1541.452,215.15,1729.537,4.867,1917.623c-0.275-0.19-0.551-0.38-0.826-0.57c1.039-1.478,2.041-2.984,3.123-4.431c29.898-39.969,63.26-76.964,97.26-113.421c40.804-43.752,82.042-87.114,122.109-131.532c35.108-38.921,66.724-80.614,91.953-126.809c19.879-36.398,34.424-74.673,40.535-115.893c7.782-52.496,1.059-103.422-17.762-152.706c-13.437-35.185-26.864-70.312-36.291-106.847c-21.394-82.908-28.324-166.979-21.201-252.304c19.974-239.28,151.763-453.739,355.913-578.35c90.292-55.114,188.023-89.471,292.95-102.908c130.165-16.669,256.024-0.09,377.981,48.558c52.942,21.118,102.709,47.566,149.092,80.552c1.22,0.868,2.42,1.767,3.601,2.688c0.244,0.19,0.36,0.544,0.758,1.179c-1.649,0.801-3.241,1.608-4.86,2.357c-71.815,33.205-143.623,66.428-215.499,99.5c-2.256,1.038-5.598,1.456-7.816,0.587c-152.615-59.802-303.123-52.584-449.63,18.494c-142.377,69.074-234.294,183.195-283.161,332.63c-22.431,68.594-30.403,139.234-23.761,211.172c11.547,125.044,63.341,231.057,152.534,319.089c1.067,1.053,2.142,2.099,3.193,3.168C635.287,1352.055,635.421,1352.372,635.931,1353.173z" />
    </motion.g>
  </svg>
)

const KimiVisual = () => (
  <motion.svg
    viewBox="0 0 100 100"
    xmlns="http://www.w3.org/2000/svg"
    className="h-[190px] w-[190px] md:h-[320px] md:w-[320px] lg:h-[360px] lg:w-[360px]"
    initial={{ opacity: 0, scale: 0.9 }}
    animate={{ opacity: 1, scale: 1 }}
    transition={{ duration: 0.8, ease: "easeOut" }}
    style={{ transformOrigin: "50% 50%" }}
  >
    <circle cx="50" cy="50" r="48" fill="#0a0a0a" />
    <text x="30" y="72" fill="#fff" fontFamily="Inter, Arial Black, sans-serif" fontSize="58" fontWeight="900">K</text>
    <motion.circle
      cx="72" cy="30" r="7" fill="#3b82f6"
      initial={{ scale: 0 }}
      animate={{ scale: [0, 1.3, 1] }}
      transition={{ duration: 0.6, delay: 0.4, ease: "easeOut" }}
      style={{ transformOrigin: "72px 30px" }}
    />
  </motion.svg>
)

// ========================= FEATURE VISUALS =========================

const SHOWCASE_IMAGES = [
  "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=600&h=600&fit=crop&q=80",
  "https://images.unsplash.com/photo-1470813740244-df37b8c1edcb?w=600&h=600&fit=crop&q=80",
  "https://images.unsplash.com/photo-1543549790-8b5f4a028cfb?w=600&h=600&fit=crop&q=80",
  "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=600&h=600&fit=crop&q=80",
  "https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=600&h=600&fit=crop&q=80",
  "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&h=600&fit=crop&q=80",
]

// One image at a time, cycling fast with a flash cut
const ImagesVisual = () => {
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % SHOWCASE_IMAGES.length)
    }, 420)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      className="relative h-[360px] w-[360px] overflow-hidden rounded-2xl md:h-[400px] md:w-[400px]"
      style={{ boxShadow: "0 20px 50px -14px rgba(99,102,241,0.35), 0 0 0 1px rgba(15,23,42,0.06)" }}
    >
      <AnimatePresence mode="wait">
        <motion.img
          key={SHOWCASE_IMAGES[idx]}
          src={SHOWCASE_IMAGES[idx]}
          alt=""
          loading="eager"
          initial={{ opacity: 0, scale: 1.08 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </AnimatePresence>
      {/* White flash on change */}
      <motion.div
        key={`flash-${idx}`}
        className="pointer-events-none absolute inset-0 bg-white"
        initial={{ opacity: 0.6 }}
        animate={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      />
      {/* Counter */}
      <div className="absolute bottom-3 right-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium tabular-nums text-white backdrop-blur">
        {String(idx + 1).padStart(2, "0")} / {String(SHOWCASE_IMAGES.length).padStart(2, "0")}
      </div>
      {/* Top scan line */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(255,255,255,0.9), transparent)",
        }}
      />
    </div>
  )
}

const SHOWCASE_VIDEO_POSTER =
  "https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=640&h=420&fit=crop&q=80"

const VideoVisual = () => (
  <motion.div
    initial={{ opacity: 0, scale: 0.94 }}
    animate={{ opacity: 1, scale: 1 }}
    transition={{ duration: 0.5, ease: "easeOut" }}
    className="relative aspect-video w-[380px] overflow-hidden rounded-2xl md:w-[440px]"
    style={{ boxShadow: "0 24px 60px -16px rgba(220,38,38,0.35), 0 0 0 1px rgba(15,23,42,0.06)" }}
  >
    <img src={SHOWCASE_VIDEO_POSTER} alt="" className="absolute inset-0 h-full w-full object-cover" />
    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/20" />
    <motion.div
      className="absolute inset-0 flex items-center justify-center"
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ delay: 0.2, duration: 0.4 }}
    >
      <motion.div
        className="relative flex h-14 w-14 items-center justify-center rounded-full bg-white/95"
        animate={{ scale: [1, 1.08, 1] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        style={{ boxShadow: "0 10px 30px -8px rgba(0,0,0,0.5)" }}
      >
        <div className="ml-1 h-0 w-0" style={{ borderTop: "9px solid transparent", borderBottom: "9px solid transparent", borderLeft: "14px solid #0f172a" }} />
      </motion.div>
    </motion.div>
    <div className="absolute bottom-3 left-3 right-3 flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/30">
        <motion.div className="h-full bg-white" initial={{ width: "0%" }} animate={{ width: "72%" }} transition={{ duration: 1.6, delay: 0.3, ease: "easeOut" }} />
      </div>
      <span className="text-[10px] font-medium tabular-nums text-white/90">00:24</span>
    </div>
    <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-1 backdrop-blur">
      <motion.span className="h-1.5 w-1.5 rounded-full bg-red-500" animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.2, repeat: Infinity }} />
      <span className="text-[9px] font-semibold uppercase tracking-wider text-white">4K · HDR</span>
    </div>
  </motion.div>
)

// Excel — animated spreadsheet mock
const ExcelVisual = () => {
  // Progressive cell fill + blinking caret in active cell
  const DATA: Array<[string, string, string, string, string]> = [
    ["Producto", "Q1", "Q2", "Q3", "Total"],
    ["Laptops", "142", "168", "203", "513"],
    ["Tablets", "98", "124", "156", "378"],
    ["Monitores", "76", "89", "112", "277"],
    ["Teléfonos", "212", "245", "291", "748"],
  ]
  const total = DATA.flat().length
  const [filled, setFilled] = useState(5) // start with headers visible
  const [activeIdx, setActiveIdx] = useState<number>(-1) // which cell is "being edited"

  useEffect(() => {
    const id = setInterval(() => {
      setFilled((n) => {
        if (n >= total) return n
        setActiveIdx(n)
        return n + 1
      })
    }, 110)
    return () => clearInterval(id)
  }, [total])

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="w-[460px] overflow-hidden rounded-xl bg-white md:w-[540px]"
      style={{
        boxShadow:
          "0 30px 70px -18px rgba(16,124,65,0.4), 0 0 0 1px rgba(15,23,42,0.06), inset 0 1px 0 rgba(255,255,255,1)",
      }}
    >
      {/* Title bar */}
      <div className="flex h-10 items-center justify-between bg-[#107c41] px-3 text-white">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-white/20 text-[13px] font-black">
            X
          </div>
          <span className="text-[12px] font-semibold tracking-wide">
            Excel · Reporte Q1–Q3
          </span>
        </div>
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
        </div>
      </div>

      {/* Formula bar */}
      <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-1.5">
        <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 border border-gray-200">
          E5
        </span>
        <span className="text-[11px] text-slate-400">fx</span>
        <code className="text-[11px] font-mono text-slate-700">
          =SUM(B5:D5)
        </code>
      </div>

      {/* Column headers (A B C D E) */}
      <div className="grid grid-cols-[28px_1fr_1fr_1fr_1fr_1fr] border-b border-gray-200">
        <div className="h-6 border-r border-gray-200 bg-gray-50" />
        {["A", "B", "C", "D", "E"].map((l) => (
          <div
            key={l}
            className="flex h-6 items-center justify-center border-r border-gray-200 bg-gray-50 text-[10px] font-semibold text-slate-500"
          >
            {l}
          </div>
        ))}
      </div>

      {/* Data rows */}
      {DATA.map((row, r) => (
        <div
          key={r}
          className="grid grid-cols-[28px_1fr_1fr_1fr_1fr_1fr]"
        >
          {/* Row number */}
          <div className="flex h-9 items-center justify-center border-r border-b border-gray-200 bg-gray-50 text-[10px] font-semibold text-slate-500">
            {r + 1}
          </div>
          {row.map((cell, c) => {
            const idx = r * 5 + c
            const visible = idx < filled
            const isHeader = r === 0
            const isTotalCol = c === 4
            const isActive = idx === activeIdx
            return (
              <motion.div
                key={c}
                initial={{ opacity: 0 }}
                animate={{
                  opacity: visible ? 1 : 0.15,
                  backgroundColor: isActive
                    ? "#dcfce7"
                    : isHeader
                    ? "#f0fdf4"
                    : isTotalCol
                    ? "#f7fee7"
                    : "#ffffff",
                }}
                transition={{ duration: 0.25 }}
                className={`relative flex h-9 items-center border-r border-b border-gray-200 px-2 text-[12px] ${
                  isHeader
                    ? "font-semibold text-[#065f46]"
                    : isTotalCol
                    ? "font-semibold text-[#065f46]"
                    : "text-slate-700"
                }`}
                style={
                  isActive
                    ? {
                        boxShadow: "inset 0 0 0 2px #10a37f",
                      }
                    : undefined
                }
              >
                <span>{visible ? cell : ""}</span>
                {isActive && (
                  <motion.span
                    className="ml-0.5 inline-block h-3 w-[1.5px] bg-[#10a37f]"
                    animate={{ opacity: [1, 0, 1] }}
                    transition={{ duration: 0.8, repeat: Infinity }}
                  />
                )}
              </motion.div>
            )
          })}
        </div>
      ))}

      {/* Status bar */}
      <div className="flex items-center justify-between bg-gray-50 px-3 py-1.5 text-[10px] text-slate-600">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[#107c41]" />
            Hoja1
          </span>
          <span className="text-slate-400">Lista</span>
        </div>
        <div className="flex gap-3">
          <span>Promedio: 148</span>
          <span>Recuento: 16</span>
          <span className="font-semibold text-slate-700">Suma: 2.370</span>
        </div>
      </div>
    </motion.div>
  )
}

// Word — document mock with title, paragraphs, table & bullet list
const WordVisual = () => (
  <motion.div
    initial={{ opacity: 0, y: 16 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.5 }}
    className="w-[460px] overflow-hidden rounded-xl bg-white md:w-[520px]"
    style={{
      boxShadow:
        "0 30px 70px -18px rgba(24,90,189,0.4), 0 0 0 1px rgba(15,23,42,0.06), inset 0 1px 0 rgba(255,255,255,1)",
    }}
  >
    {/* Title bar */}
    <div className="flex h-10 items-center justify-between bg-[#185abd] px-3 text-white">
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-white/20 text-[13px] font-black">W</div>
        <span className="text-[12px] font-semibold tracking-wide">Word · Propuesta.docx</span>
      </div>
      <div className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
      </div>
    </div>

    {/* Ribbon */}
    <div className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-3 py-1.5">
      <span className="text-[10px] font-semibold text-slate-600">Inicio</span>
      <span className="text-[10px] text-slate-400">Insertar</span>
      <span className="text-[10px] text-slate-400">Diseño</span>
      <span className="text-[10px] text-slate-400">Revisar</span>
      <div className="ml-auto flex items-center gap-1">
        <span className="rounded bg-white px-1.5 py-0.5 text-[9px] font-semibold text-slate-500 border border-gray-200">Calibri</span>
        <span className="text-[9px] text-slate-400">12</span>
      </div>
    </div>

    {/* Document page */}
    <div className="bg-gray-100 p-5">
      <div
        className="relative mx-auto overflow-hidden bg-white px-8 py-6"
        style={{
          boxShadow: "0 4px 16px -4px rgba(15,23,42,0.15), 0 0 0 1px rgba(15,23,42,0.04)",
        }}
      >
        {/* Page margin guides (subtle) */}
        <div className="absolute left-4 top-4 text-[8px] text-slate-300">1</div>

        {/* Title */}
        <motion.h2
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.4 }}
          className="mb-1 text-[15px] font-bold text-[#185abd]"
        >
          Propuesta Comercial 2026
        </motion.h2>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.4 }}
          className="mb-3 text-[9px] italic text-slate-400"
        >
          Sira GPT · Plan Enterprise
        </motion.p>

        {/* Body paragraphs — animated typing-like width expansion */}
        <div className="space-y-1.5">
          {[94, 90, 82, 48].map((w, i) => (
            <motion.div
              key={i}
              initial={{ width: 0 }}
              animate={{ width: `${w}%` }}
              transition={{ duration: 0.5, delay: 0.3 + i * 0.08 }}
              className="h-[6px] rounded-sm bg-slate-300"
            />
          ))}
        </div>

        {/* Section heading */}
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7, duration: 0.4 }}
          className="mt-4 mb-2 text-[11px] font-bold text-slate-800"
        >
          Beneficios
        </motion.div>

        {/* Bullet list */}
        <div className="mb-3 space-y-1">
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.8 + i * 0.1, duration: 0.35 }}
              className="flex items-center gap-2"
            >
              <span className="h-1 w-1 rounded-full bg-[#185abd]" />
              <div
                className="h-[6px] rounded-sm bg-slate-300"
                style={{ width: `${[80, 62, 74][i]}%` }}
              />
            </motion.div>
          ))}
        </div>

        {/* Mini table */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.1, duration: 0.5 }}
          className="mt-3 overflow-hidden rounded border border-slate-200"
        >
          <div className="grid grid-cols-3 bg-[#eef4fc]">
            {["Plan", "Usuarios", "Precio"].map((h) => (
              <div key={h} className="border-r border-slate-200 px-2 py-1 text-[9px] font-bold text-[#185abd] last:border-r-0">{h}</div>
            ))}
          </div>
          {[
            ["Pro", "25", "€49"],
            ["Team", "100", "€129"],
            ["Enterprise", "∞", "Custom"],
          ].map((row, r) => (
            <div key={r} className="grid grid-cols-3 border-t border-slate-100">
              {row.map((c, i) => (
                <div key={i} className="border-r border-slate-100 px-2 py-1 text-[9px] text-slate-600 last:border-r-0">{c}</div>
              ))}
            </div>
          ))}
        </motion.div>
      </div>
    </div>

    {/* Status bar */}
    <div className="flex items-center justify-between bg-[#185abd] px-3 py-1 text-[9px] text-white/90">
      <div className="flex gap-3">
        <span>Página 1 de 1</span>
        <span>342 palabras</span>
        <span>Español</span>
      </div>
      <span>100%</span>
    </div>
  </motion.div>
)

// PowerPoint — deck with thumbnails + active slide featuring animated chart
const PPTVisual = () => {
  const bars = [62, 78, 54, 88, 95]
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="w-[460px] overflow-hidden rounded-xl bg-white md:w-[540px]"
      style={{
        boxShadow:
          "0 30px 70px -18px rgba(196,62,28,0.4), 0 0 0 1px rgba(15,23,42,0.06), inset 0 1px 0 rgba(255,255,255,1)",
      }}
    >
      {/* Title bar */}
      <div className="flex h-10 items-center justify-between bg-[#c43e1c] px-3 text-white">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-white/20 text-[13px] font-black">P</div>
          <span className="text-[12px] font-semibold tracking-wide">PowerPoint · Pitch.pptx</span>
        </div>
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
        </div>
      </div>

      {/* Ribbon */}
      <div className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-3 py-1.5">
        <span className="text-[10px] font-semibold text-slate-600">Presentación</span>
        <span className="text-[10px] text-slate-400">Transiciones</span>
        <span className="text-[10px] text-slate-400">Animaciones</span>
        <span className="ml-auto rounded bg-[#c43e1c] px-2 py-0.5 text-[9px] font-semibold text-white">▶ Presentar</span>
      </div>

      <div className="flex gap-3 bg-gray-100 p-3">
        {/* Thumbnail stack (left) */}
        <div className="flex w-16 flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.35, delay: 0.1 + i * 0.08 }}
              className="relative"
            >
              <span className="absolute -left-3 top-1/2 -translate-y-1/2 text-[8px] font-semibold text-slate-400">{i + 1}</span>
              <div
                className={`aspect-[4/3] overflow-hidden rounded ${
                  i === 0 ? "ring-2 ring-[#c43e1c]" : "ring-1 ring-slate-300"
                }`}
                style={{
                  background:
                    i === 0
                      ? "linear-gradient(135deg, #c43e1c, #f97316)"
                      : "#ffffff",
                }}
              >
                {i !== 0 && (
                  <div className="flex h-full flex-col items-start justify-end p-1">
                    <div className="h-0.5 w-6 rounded bg-slate-300" />
                    <div className="mt-0.5 h-0.5 w-8 rounded bg-slate-200" />
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </div>

        {/* Active big slide */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="relative flex flex-1 aspect-[16/10] flex-col overflow-hidden rounded-lg"
          style={{
            background:
              "linear-gradient(135deg, #c43e1c 0%, #dc2626 50%, #f97316 100%)",
            boxShadow: "0 10px 30px -8px rgba(196,62,28,0.4)",
          }}
        >
          {/* Decorative circles */}
          <div
            aria-hidden
            className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white/10 blur-xl"
          />
          <div
            aria-hidden
            className="absolute -left-6 -bottom-6 h-24 w-24 rounded-full bg-white/10 blur-lg"
          />

          <div className="relative flex h-full flex-col p-4">
            {/* Top label */}
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="mb-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-white/70"
            >
              Q1 · 2026
            </motion.div>
            <motion.h3
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.5 }}
              className="mb-1 text-[16px] font-bold leading-tight text-white"
            >
              Crecimiento de usuarios
            </motion.h3>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="mb-3 text-[9px] text-white/80"
            >
              +48% interanual en el último trimestre
            </motion.p>

            {/* Bar chart */}
            <div className="mt-auto flex h-16 items-end gap-2">
              {bars.map((h, i) => (
                <motion.div
                  key={i}
                  initial={{ height: "0%" }}
                  animate={{ height: `${h}%` }}
                  transition={{ delay: 0.6 + i * 0.08, duration: 0.5, ease: "easeOut" }}
                  className="flex-1 rounded-t bg-white/90"
                  style={{ boxShadow: "inset 0 -4px 8px rgba(255,255,255,0.3)" }}
                />
              ))}
            </div>
            {/* Axis labels */}
            <div className="mt-1 flex gap-2 text-[8px] text-white/70">
              {["Ene", "Feb", "Mar", "Abr", "May"].map((m) => (
                <span key={m} className="flex-1 text-center">{m}</span>
              ))}
            </div>
          </div>
        </motion.div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between bg-gray-50 px-3 py-1.5 text-[10px] text-slate-600">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[#c43e1c]" />
            Diapositiva 1 de 12
          </span>
          <span className="text-slate-400">Español</span>
        </div>
        <span>🎨 Tema Ignite</span>
      </div>
    </motion.div>
  )
}

// Webs — browser window with code-like content
const WebsVisual = () => (
  <motion.div
    initial={{ opacity: 0, y: 16 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.5 }}
    className="w-[380px] overflow-hidden rounded-xl bg-white md:w-[440px]"
    style={{ boxShadow: "0 20px 50px -14px rgba(14,165,233,0.35), 0 0 0 1px rgba(15,23,42,0.06)" }}
  >
    {/* Chrome */}
    <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
      <div className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
      </div>
      <div className="ml-2 flex-1 rounded-md bg-white px-2 py-1 text-[10px] text-slate-400">
        https://tu-web.com
      </div>
    </div>
    {/* Content */}
    <div className="relative h-[200px] overflow-hidden bg-gradient-to-br from-slate-50 to-white p-5">
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="mb-2 h-3 w-40 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500" />
      <motion.div initial={{ width: 0 }} animate={{ width: "90%" }} transition={{ duration: 0.5, delay: 0.3 }} className="mb-1.5 h-2 rounded bg-slate-300" />
      <motion.div initial={{ width: 0 }} animate={{ width: "75%" }} transition={{ duration: 0.5, delay: 0.4 }} className="mb-4 h-2 rounded bg-slate-300" />
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.5 + i * 0.1 }}
            className="h-16 rounded-md bg-gradient-to-br from-sky-400 to-indigo-500"
          />
        ))}
      </div>
    </div>
  </motion.div>
)

// GitHub + MCP — octocat mark connected to Sira core via animated link
const GitHubMCPVisual = ({ color }: { color: string }) => (
  <div
    className="relative flex h-[360px] w-[400px] items-center justify-center overflow-hidden rounded-3xl border border-slate-200/60 bg-gradient-to-b from-white/80 to-white/40 p-8 shadow-[0_24px_60px_-20px_rgba(79,70,229,0.35)] dark:border-white/10 dark:from-white/[0.07] dark:to-white/[0.02] dark:shadow-[0_28px_70px_-24px_rgba(99,102,241,0.45)] md:h-[400px] md:w-[460px]"
    style={{ boxShadow: "0 24px 60px -20px rgba(79,70,229,0.28), 0 0 0 1px rgba(255,255,255,0.06) inset" }}
  >
    <div
      aria-hidden
      className="pointer-events-none absolute -left-16 top-1/2 h-40 w-40 -translate-y-1/2 rounded-full opacity-70 blur-3xl dark:opacity-90"
      style={{ background: `radial-gradient(circle, ${color}55 0%, transparent 70%)` }}
    />
    <div
      aria-hidden
      className="pointer-events-none absolute -right-12 top-1/3 h-36 w-36 rounded-full opacity-60 blur-3xl dark:opacity-80"
      style={{ background: "radial-gradient(circle, rgba(99,102,241,0.45) 0%, transparent 70%)" }}
    />

    {/* Connection line with glow + traveling dot */}
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 440 380" fill="none" aria-hidden>
      <defs>
        <linearGradient id="mcpLinkGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="50%" stopColor="#818cf8" stopOpacity="1" />
          <stop offset="100%" stopColor={color} stopOpacity="0.5" />
        </linearGradient>
      </defs>
      <motion.path
        d="M 100 190 Q 220 140 340 190"
        stroke="url(#mcpLinkGrad)"
        strokeWidth="10"
        strokeLinecap="round"
        opacity={0.35}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.9, ease: "easeOut" }}
      />
      <motion.path
        d="M 100 190 Q 220 140 340 190"
        stroke={color}
        strokeWidth="2"
        strokeDasharray="6 6"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.9, ease: "easeOut" }}
      />
      <motion.circle
        r="6"
        fill="#e0e7ff"
        initial={{ offsetDistance: "0%" }}
        animate={{ offsetDistance: "100%" }}
        transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut", delay: 0.9 }}
        style={{
          filter: "drop-shadow(0 0 6px rgba(129,140,248,0.9))",
          offsetPath: `path("M 100 190 Q 220 140 340 190")`,
        } as CSSProperties}
      />
    </svg>

    {/* GitHub octocat (left) */}
    <motion.div
      initial={{ opacity: 0, x: -12, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1, y: [0, -3, 0] }}
      transition={{
        y: { duration: 4, repeat: Infinity, ease: "easeInOut" },
        default: { duration: 0.5 },
      }}
      className="absolute left-6 top-1/2 z-[1] -translate-y-1/2 flex h-[5.5rem] w-[5.5rem] items-center justify-center rounded-2xl bg-white ring-1 ring-slate-200/80 dark:bg-zinc-900 dark:ring-white/15"
      style={{ boxShadow: "0 16px 40px -12px rgba(15,23,42,0.35), 0 0 0 1px rgba(15,23,42,0.04)" }}
    >
      <svg viewBox="0 0 24 24" className="h-14 w-14 text-slate-900 dark:text-white" aria-hidden>
        <path
          fill="currentColor"
          d="M12 .5C5.37.5 0 5.78 0 12.292c0 5.211 3.438 9.63 8.205 11.188.6.111.82-.254.82-.567 0-.28-.01-1.022-.015-2.005-3.338.711-4.042-1.582-4.042-1.582-.546-1.361-1.335-1.725-1.335-1.725-1.087-.731.084-.716.084-.716 1.205.082 1.838 1.215 1.838 1.215 1.07 1.803 2.809 1.282 3.495.981.108-.763.417-1.282.76-1.577-2.665-.295-5.466-1.309-5.466-5.827 0-1.287.465-2.339 1.235-3.164-.135-.298-.54-1.497.105-3.121 0 0 1.005-.316 3.3 1.209.96-.262 1.98-.392 3-.398 1.02.006 2.04.136 3 .398 2.28-1.525 3.285-1.209 3.285-1.209.645 1.624.24 2.823.12 3.121.765.825 1.23 1.877 1.23 3.164 0 4.53-2.805 5.527-5.475 5.817.42.354.81 1.077.81 2.182 0 1.578-.015 2.846-.015 3.229 0 .309.21.678.825.561C20.565 21.917 24 17.495 24 12.292 24 5.78 18.627.5 12 .5z"
        />
      </svg>
    </motion.div>

    {/* MCP badge (center) */}
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: [1, 1.04, 1] }}
      transition={{
        scale: { duration: 2.2, repeat: Infinity, ease: "easeInOut", delay: 0.5 },
        default: { duration: 0.45, delay: 0.25 },
      }}
      className="absolute left-1/2 top-1/2 z-[2] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-b from-indigo-400 to-indigo-600 px-3.5 py-1.5 text-[10px] font-bold tracking-[0.2em] text-white shadow-lg shadow-indigo-500/40 ring-2 ring-white/25 dark:from-indigo-500 dark:to-indigo-700"
    >
      MCP
    </motion.div>

    {/* Sira core (right) */}
    <motion.div
      initial={{ opacity: 0, x: 12, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1, y: [0, 3, 0] }}
      transition={{
        y: { duration: 4.5, repeat: Infinity, ease: "easeInOut", delay: 0.3 },
        default: { duration: 0.5, delay: 0.15 },
      }}
      className="absolute right-6 top-1/2 z-[1] -translate-y-1/2 flex h-[5.5rem] w-[5.5rem] items-center justify-center rounded-full"
      style={{
        background: `radial-gradient(circle at 30% 25%, ${color} 0%, #6366f1 42%, #312e81 100%)`,
        boxShadow: `0 18px 44px -12px rgba(67,56,202,0.55), 0 0 0 2px rgba(255,255,255,0.22) inset, 0 0 40px -8px ${color}66`,
      }}
    >
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-[-6px] rounded-full border border-white/20"
        animate={{ opacity: [0.4, 0.9, 0.4], scale: [1, 1.06, 1] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
      />
      <img src="/sira-gpt.png" alt="" className="relative z-[1] h-12 w-12 brightness-0 invert" />
    </motion.div>
  </div>
)

// ========================= BRAND DATA =========================

type Brand = {
  id: string
  accent: string
  tagline: string
  /** Shown under the tagline during the “display” phase only */
  subtitle?: string
  Visual: React.ComponentType<{ color: string }>
}

const BRANDS: Brand[] = [
  { id: "claude",   accent: "#d97757", tagline: "ACCEDE A CLAUDE MAX",       Visual: ClaudeVisual },
  { id: "chatgpt",  accent: "#10a37f", tagline: "CHATEA CON CHATGPT PRO",    Visual: ChatGPTVisual },
  { id: "gemini",   accent: "#4285f4", tagline: "POTENCIA CON GEMINI 2.5",   Visual: GeminiVisual },
  { id: "grok",     accent: "#0f172a", tagline: "EXPLORA CON GROK 4",        Visual: GrokVisual },
  { id: "kimi",     accent: "#3b82f6", tagline: "USA KIMI K2.6",             Visual: KimiVisual },
  { id: "images",   accent: "#6366f1", tagline: "GENERA IMÁGENES IA",        Visual: ImagesVisual },
  { id: "video",    accent: "#dc2626", tagline: "CREA VIDEOS 4K",            Visual: VideoVisual },
  { id: "excel",    accent: "#107c41", tagline: "CREA EXCEL PROFESIONAL",    Visual: ExcelVisual },
  { id: "word",     accent: "#185abd", tagline: "CREA WORD PROFESIONAL",     Visual: WordVisual },
  { id: "ppt",      accent: "#c43e1c", tagline: "CREA PPT PROFESIONAL",      Visual: PPTVisual },
  { id: "webs",     accent: "#0ea5e9", tagline: "CREA WEBS PROFESIONALES",   Visual: WebsVisual },
  {
    id: "github",
    accent: "#a5b4fc",
    tagline: "CONECTA MCP CON GITHUB",
    subtitle: "Herramientas y repositorios enlazados de forma segura a tu flujo en Sira.",
    Visual: GitHubMCPVisual,
  },
]

// ========================= LOADER BARS =========================

const LoaderBars = ({ color }: { color: string }) => (
  <svg viewBox="10 40 45 50" xmlns="http://www.w3.org/2000/svg" className="h-8 w-14" style={{ color }} aria-label="Loading">
    <rect x="20" y="50" width="4" height="10" fill="currentColor">
      <animateTransform attributeName="transform" type="translate" values="0 0; 0 20; 0 0" begin="0s" dur="0.6s" repeatCount="indefinite" />
    </rect>
    <rect x="30" y="50" width="4" height="10" fill="currentColor">
      <animateTransform attributeName="transform" type="translate" values="0 0; 0 20; 0 0" begin="0.2s" dur="0.6s" repeatCount="indefinite" />
    </rect>
    <rect x="40" y="50" width="4" height="10" fill="currentColor">
      <animateTransform attributeName="transform" type="translate" values="0 0; 0 20; 0 0" begin="0.4s" dur="0.6s" repeatCount="indefinite" />
    </rect>
  </svg>
)

// ========================= BRAND CARD =========================

const BAR_DURATION = 1200
const TYPE_INTERVAL = 52
const AFTER_TYPING_HOLD = 300
const DISPLAY_DURATION = 2400

function BrandCard({ brand, onDone }: { brand: Brand; onDone: () => void }) {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)')
    setIsMobile(mql.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  const [phase, setPhase] = useState<"bars" | "typing" | "display">("bars")
  const [typed, setTyped] = useState("")

  useEffect(() => {
    const t = setTimeout(() => setPhase("typing"), BAR_DURATION)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (phase !== "typing") return
    let i = 0
    const id = setInterval(() => {
      i += 1
      setTyped(brand.tagline.slice(0, i))
      if (i >= brand.tagline.length) {
        clearInterval(id)
        const hold = setTimeout(() => setPhase("display"), AFTER_TYPING_HOLD)
        return () => clearTimeout(hold)
      }
    }, TYPE_INTERVAL)
    return () => clearInterval(id)
  }, [phase, brand.tagline])

  useEffect(() => {
    if (phase !== "display") return
    const t = setTimeout(onDone, DISPLAY_DURATION)
    return () => clearTimeout(t)
  }, [phase, onDone])

  const { Visual, accent } = brand

  return (
    <div className={`relative w-full ${isMobile ? 'h-[260px]' : 'h-[540px]'}`}>
      {/* Visual — absolutely centered, large */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-[-40px]"
            style={{
              background: `radial-gradient(circle at 50% 50%, ${accent}33, ${accent}0d 45%, transparent 70%)`,
              filter: "blur(14px)",
            }}
          />
          <div className="relative">
            <Visual color={accent} />
          </div>
        </div>
      </div>

      {/* Tagline (+ optional subtitle) — top left */}
      <div className="absolute top-0 left-0 z-[2] flex max-w-[min(100%,520px)] flex-col items-start gap-2 pr-4">
        <AnimatePresence mode="wait">
          {phase === "bars" ? (
            <motion.div
              key="bars"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85, x: -4 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="flex h-14 items-center"
            >
              <LoaderBars color={accent} />
            </motion.div>
          ) : (
            <motion.div
              key="text"
              initial={{ opacity: 0, x: -8, filter: "blur(6px)" }}
              animate={{
                opacity: 1,
                x: 0,
                filter: "blur(0px)",
                ...(phase === "display"
                  ? { scale: [1, 1.015, 1], letterSpacing: ["0.22em", "0.24em", "0.22em"] }
                  : {}),
              }}
              transition={{
                duration: phase === "display" ? 0.85 : 0.35,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="rounded-lg border border-slate-200/80 bg-white/85 px-2 py-1 text-[14px] font-semibold uppercase tracking-[0.18em] shadow-[0_8px_30px_-12px_rgba(15,23,42,0.12)] backdrop-blur-sm dark:border-white/10 dark:bg-black/40 dark:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.5)] md:text-[21px] md:px-3 md:py-1.5 md:tracking-[0.22em]"
            >
              <span className="dark:hidden" style={{ color: accent }}>
                {typed}
              </span>
              <span className="hidden bg-gradient-to-r from-white via-indigo-100 to-slate-200 bg-clip-text text-transparent dark:inline">
                {typed}
              </span>
              <motion.span
                className="ml-0.5 inline-block align-middle text-slate-800 dark:text-white/90"
                animate={{ opacity: phase === "typing" ? [1, 0, 1] : 0 }}
                transition={{ duration: 0.85, repeat: phase === "typing" ? Infinity : 0, ease: "easeInOut" }}
              >
                |
              </motion.span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {phase === "display" && brand.subtitle ? (
            <motion.p
              key="sub"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.4, ease: "easeOut", delay: 0.08 }}
              className="max-w-md text-[13px] leading-relaxed text-slate-600 dark:text-slate-400 md:text-[14px]"
            >
              {brand.subtitle}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ========================= CYCLE CONTAINER =========================

export function BrandCycle() {
  const [idx, setIdx] = useState(0)
  const handleDone = useCallback(() => {
    setIdx((i) => (i + 1) % BRANDS.length)
  }, [])
  const brand = BRANDS[idx]

  return (
    <div className="relative flex w-full items-center justify-center">
      <AnimatePresence mode="wait">
        <motion.div
          key={brand.id}
          initial={{ opacity: 0, scale: 0.94, filter: "blur(10px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{
            opacity: 0,
            scale: 1.06,
            filter: "blur(14px)",
            transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] },
          }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="w-full"
        >
          <BrandCard brand={brand} onDone={handleDone} />
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
