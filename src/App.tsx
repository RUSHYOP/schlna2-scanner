import { useState, useRef, useEffect, useCallback } from "react";
import { Html5Qrcode } from "html5-qrcode";

const API_URL = import.meta.env.VITE_API_URL || "https://api.saividyafest.live";
const SCAN_CUTOFF = Date.UTC(2026, 3, 18, 9, 30, 0); // April 18, 2026, 3:00 PM IST
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache for pass data
const FETCH_TIMEOUT = 15000; // 15 second timeout for API calls (increased for crowd)

interface PassData {
  valid: boolean;
  passCode: string;
  passType: string;
  name: string;
  email: string;
  phone: string;
  collegeName: string | null;
  department: string | null;
  usn: string | null;
  hasAadhaar: boolean;
  aadhaarMimeType: string | null;
  hasCollegeId: boolean;
  collegeIdMimeType: string | null;
  createdAt: string;
}

interface CachedPass {
  data: PassData;
  timestamp: number;
}

interface ScanResult {
  dryRun: boolean;
  firstScan: boolean;
  message: string;
}

type ScanState = "scanning" | "loading" | "result" | "error";

// In-memory cache for recently scanned passes (shared across re-renders)
const passCache = new Map<string, CachedPass>();

// Fetch with timeout and retry for reliability under load
async function fetchWithRetry(url: string, options: RequestInit = {}, timeout = FETCH_TIMEOUT, retries = 2): Promise<Response> {
  let lastError: Error | null = null;
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { 
        ...options, 
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
      });
      clearTimeout(id);
      return response;
    } catch (err) {
      clearTimeout(id);
      lastError = err as Error;
      console.warn(`Fetch attempt ${i + 1} failed:`, err);
      if (i < retries) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1))); // backoff: 1s, 2s
      }
    }
  }
  throw lastError;
}

export default function App() {
  const [state, setState] = useState<ScanState>("scanning");
  const [passData, setPassData] = useState<PassData | null>(null);
  const [aadhaarUrl, setAadhaarUrl] = useState<string | null>(null);
  const [aadhaarPdfCanvas, setAadhaarPdfCanvas] = useState<string | null>(null);
  const [collegeIdUrl, setCollegeIdUrl] = useState<string | null>(null);
  const [collegeIdPdfCanvas, setCollegeIdPdfCanvas] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Pinch-zoom state
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);
  const lastDragPos = useRef<{ x: number; y: number } | null>(null);

  const [countdown, setCountdown] = useState("");
  const [isLive, setIsLive] = useState(Date.now() >= SCAN_CUTOFF);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);

  const extractPassCode = (text: string): string | null => {
    const trimmed = text.trim();
    const urlMatch = trimmed.match(/verify\/((SANCHALANA|SCHLNA)-[A-F0-9]+)/i);
    if (urlMatch) return urlMatch[1].toUpperCase();
    const codeMatch = trimmed.match(/(SANCHALANA|SCHLNA)-[A-F0-9]+/i);
    if (codeMatch) return codeMatch[0].toUpperCase();
    return null;
  };

  const fetchPassData = useCallback(async (passCode: string) => {
    setState("loading");
    
    // Check cache first for faster response
    const cached = passCache.get(passCode);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setPassData(cached.data);
      // Still record scan even for cached data
      fetchWithRetry(`${API_URL}/api/scan/${passCode}`, { method: "POST" })
        .then(async (scanRes) => { if (scanRes.ok) setScanResult(await scanRes.json()); })
        .catch(() => {});
      setState("result");
      return;
    }
    
    try {
      const res = await fetchWithRetry(`${API_URL}/api/verify/${passCode}/json`);
      if (!res.ok) {
        setErrorMsg(res.status === 404 ? "Pass not found — invalid or revoked" : "Server error");
        setState("error");
        return;
      }
      const data: PassData = await res.json();
      if (!data.valid) {
        setErrorMsg("Invalid pass");
        setState("error");
        return;
      }
      
      // Cache the pass data
      passCache.set(passCode, { data, timestamp: Date.now() });
      // Keep cache size bounded (max 100 entries)
      if (passCache.size > 100) {
        const oldest = passCache.keys().next().value;
        if (oldest) passCache.delete(oldest);
      }
      
      setPassData(data);

      // Fetch documents and record scan in parallel for speed
      const fetchPromises: Promise<void>[] = [];

      // Record scan (fire immediately, don't block UI)
      fetchPromises.push(
        fetchWithRetry(`${API_URL}/api/scan/${passCode}`, { method: "POST" })
          .then(async (scanRes) => { if (scanRes.ok) setScanResult(await scanRes.json()); })
          .catch(() => { /* scan recording is non-critical */ })
      );

      // Fetch Aadhaar if available
      if (data.hasAadhaar) {
        fetchPromises.push(
          fetchWithRetry(`${API_URL}/api/verify/${passCode}/aadhaar`, {}, 15000)
            .then(async (aadhaarRes) => {
              if (aadhaarRes.ok) {
                const blob = await aadhaarRes.blob();
                if (data.aadhaarMimeType === "application/pdf") {
                  await renderPdf(blob, "aadhaar");
                } else {
                  setAadhaarUrl(URL.createObjectURL(blob));
                }
              }
            })
            .catch(() => { /* Aadhaar fetch failed — non-critical */ })
        );
      }

      // Fetch College ID if available
      if (data.hasCollegeId) {
        fetchPromises.push(
          fetchWithRetry(`${API_URL}/api/verify/${passCode}/college-id`, {}, 15000)
            .then(async (collegeIdRes) => {
              if (collegeIdRes.ok) {
                const blob = await collegeIdRes.blob();
                if (data.collegeIdMimeType === "application/pdf") {
                  await renderPdf(blob, "collegeId");
                } else {
                  setCollegeIdUrl(URL.createObjectURL(blob));
                }
              }
            })
            .catch(() => { /* College ID fetch failed — non-critical */ })
        );
      }

      // Don't await — let these load in background while showing result
      Promise.all(fetchPromises);

      setState("result");
    } catch (err) {
      console.error("Fetch error:", err);
      let msg = "Network error — check WiFi/data connection";
      if (err instanceof Error) {
        if (err.name === 'AbortError') msg = "Request timed out — tap Rescan to retry";
        else if (err.message.includes('Failed to fetch')) msg = "Cannot reach server — check internet connection";
      }
      setErrorMsg(msg);
      setState("error");
    }
  }, []);

  const renderPdf = async (blob: Blob, target: "aadhaar" | "collegeId" = "aadhaar") => {
    try {
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
      const arrayBuffer = await blob.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL("image/png");
      if (target === "collegeId") {
        setCollegeIdPdfCanvas(dataUrl);
      } else {
        setAadhaarPdfCanvas(dataUrl);
      }
    } catch {
      // PDF render failed
    }
  };

  const startScanner = useCallback(async () => {
    setPassData(null);
    setErrorMsg("");
    setScale(1);
    setTranslate({ x: 0, y: 0 });
    if (aadhaarUrl) {
      URL.revokeObjectURL(aadhaarUrl);
      setAadhaarUrl(null);
    }
    if (collegeIdUrl) {
      URL.revokeObjectURL(collegeIdUrl);
      setCollegeIdUrl(null);
    }
    setAadhaarPdfCanvas(null);
    setCollegeIdPdfCanvas(null);
    setScanResult(null);
    setState("scanning");

    await new Promise((r) => setTimeout(r, 150));

    if (!readerRef.current) return;

    try {
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;
      
      const containerWidth = readerRef.current.offsetWidth || 300;
      const qrBoxSize = Math.min(300, Math.floor(containerWidth * 0.7));
      
      await scanner.start(
        { facingMode: "environment" },
        { 
          fps: 15,
          qrbox: { width: qrBoxSize, height: qrBoxSize },
          aspectRatio: 1.0,
          disableFlip: false,
        },
        (text) => {
          const passCode = extractPassCode(text);
          if (passCode) {
            scanner.stop().catch(() => {});
            scannerRef.current = null;
            fetchPassData(passCode);
          }
        },
        () => {}
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Camera access denied";
      setErrorMsg(message);
      setState("error");
    }
  }, [fetchPassData, aadhaarUrl, collegeIdUrl]);

  useEffect(() => {
    startScanner();
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
        scannerRef.current = null;
      }
      if (aadhaarUrl) URL.revokeObjectURL(aadhaarUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const tick = () => {
      const diff = SCAN_CUTOFF - Date.now();
      if (diff <= 0) { setIsLive(true); setCountdown(""); return; }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(d > 0 ? `${d}d ${h}h ${m}m ${s}s` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist.current = Math.sqrt(dx * dx + dy * dy);
      lastTouchCenter.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    } else if (e.touches.length === 1 && scale > 1) {
      isDragging.current = true;
      lastDragPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastTouchDist.current) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const newScale = Math.min(5, Math.max(1, scale * (dist / lastTouchDist.current)));
      setScale(newScale);
      lastTouchDist.current = dist;
      if (newScale <= 1) setTranslate({ x: 0, y: 0 });
    } else if (e.touches.length === 1 && isDragging.current && lastDragPos.current) {
      const dx = e.touches[0].clientX - lastDragPos.current.x;
      const dy = e.touches[0].clientY - lastDragPos.current.y;
      setTranslate((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      lastDragPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchEnd = () => {
    lastTouchDist.current = null;
    lastTouchCenter.current = null;
    isDragging.current = false;
    lastDragPos.current = null;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const newScale = Math.min(5, Math.max(1, scale - e.deltaY * 0.002));
    setScale(newScale);
    if (newScale <= 1) setTranslate({ x: 0, y: 0 });
  };

  const passTypeLabel = (t: string) => t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white flex flex-col">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#C9A84C] to-[#8B6914] px-6 py-4 text-center">
        <h1 className="text-xl font-bold text-black tracking-wide">SANCHALANA SAMVEGA 2026</h1>
        <p className="text-sm text-black/60">Pass Verification Scanner</p>
      </div>

      {/* Scan mode indicator */}
      {isLive ? (
        <div className="bg-green-500/15 border-b border-green-500/30 px-4 py-2 text-center">
          <span className="text-green-400 text-sm font-semibold tracking-widest uppercase">🟢 Live — Scans are recorded</span>
        </div>
      ) : (
        <div className="bg-yellow-500/10 border-b border-yellow-500/30 px-4 py-3 text-center">
          <p className="text-yellow-400 text-sm font-semibold tracking-widest uppercase">🧪 Test Mode</p>
          <p className="text-yellow-400/70 text-xs mt-0.5">Scans are not recorded • Event in <span className="font-mono font-semibold">{countdown}</span></p>
        </div>
      )}

      <div className="flex-1 flex flex-col items-center justify-center p-4" ref={containerRef}>
        {state === "scanning" && (
          <div className="w-full max-w-md space-y-4">
            <div className="text-center mb-4">
              <p className="text-[#C9A84C] text-sm font-semibold tracking-widest uppercase">Scan QR Code</p>
              <p className="text-gray-400 text-xs mt-1">Point camera at the pass QR code</p>
            </div>
            <div
              id="qr-reader"
              ref={readerRef}
              className="w-full rounded-xl overflow-hidden border border-[#C9A84C]/30"
            />
          </div>
        )}

        {state === "loading" && (
          <div className="text-center space-y-4">
            <div className="w-12 h-12 border-4 border-[#C9A84C]/30 border-t-[#C9A84C] rounded-full animate-spin mx-auto" />
            <p className="text-gray-400">Verifying pass…</p>
          </div>
        )}

        {state === "error" && (
          <div className="w-full max-w-md text-center space-y-6">
            <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-8">
              <div className="text-5xl mb-4">✗</div>
              <h2 className="text-red-400 text-xl font-bold mb-2">Verification Failed</h2>
              <p className="text-gray-400">{errorMsg}</p>
            </div>
            <button
              onClick={startScanner}
              className="bg-[#C9A84C] text-black font-bold py-3 px-8 rounded-xl text-lg hover:bg-[#d4b85c] transition-colors"
            >
              Rescan
            </button>
          </div>
        )}

        {state === "result" && passData && (
          <div className="w-full max-w-md space-y-4">
            {scanResult?.dryRun ? (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-2xl p-4 text-center">
                <div className="text-4xl mb-2">✓</div>
                <h2 className="text-yellow-400 text-2xl font-bold tracking-wide">VERIFIED</h2>
                <p className="text-yellow-400/70 text-xs mt-1 tracking-widest uppercase">Test mode — not recorded</p>
              </div>
            ) : scanResult?.firstScan ? (
              <div className="bg-green-500/15 border border-green-500/30 rounded-2xl p-4 text-center">
                <div className="text-4xl mb-2">✓</div>
                <h2 className="text-green-400 text-2xl font-bold tracking-wide">ENTRY RECORDED</h2>
                <p className="text-green-400/70 text-xs mt-1 tracking-widest uppercase">First scan</p>
              </div>
            ) : scanResult ? (
              <div className="bg-blue-500/15 border border-blue-500/30 rounded-2xl p-4 text-center">
                <div className="text-4xl mb-2">⚠</div>
                <h2 className="text-blue-400 text-2xl font-bold tracking-wide">ALREADY SCANNED</h2>
                <p className="text-blue-400/70 text-xs mt-1 tracking-widest uppercase">Previously recorded</p>
              </div>
            ) : (
              <div className="bg-green-500/15 border border-green-500/30 rounded-2xl p-4 text-center">
                <div className="text-4xl mb-2">✓</div>
                <h2 className="text-green-400 text-2xl font-bold tracking-wide">VALIDATED</h2>
              </div>
            )}

            <div className="bg-gradient-to-br from-[#1a1a2e] to-[#16213e] border border-[#C9A84C]/30 rounded-2xl overflow-hidden">
              <div className="p-5 space-y-3">
                <div className="inline-block bg-[#C9A84C]/20 text-[#C9A84C] px-3 py-1 rounded-full text-xs font-semibold tracking-widest uppercase">
                  {passTypeLabel(passData.passType)}
                </div>
                <div>
                  <label className="text-gray-500 text-[11px] tracking-widest uppercase">Name</label>
                  <p className="text-white text-lg font-medium">{passData.name}</p>
                </div>
                <div>
                  <label className="text-gray-500 text-[11px] tracking-widest uppercase">Email</label>
                  <p className="text-white">{passData.email}</p>
                </div>
                <div>
                  <label className="text-gray-500 text-[11px] tracking-widest uppercase">Phone</label>
                  <p className="text-white">{passData.phone}</p>
                </div>
                {passData.collegeName && (
                  <div>
                    <label className="text-gray-500 text-[11px] tracking-widest uppercase">College</label>
                    <p className="text-white">{passData.collegeName}</p>
                  </div>
                )}
                {passData.usn && (
                  <div>
                    <label className="text-gray-500 text-[11px] tracking-widest uppercase">USN</label>
                    <p className="text-white">{passData.usn}</p>
                  </div>
                )}
                <div className="bg-black/40 border border-[#C9A84C]/20 rounded-xl p-3 text-center mt-4">
                  <label className="text-[#C9A84C] text-[11px] tracking-[3px] uppercase">Pass Code</label>
                  <p className="font-mono text-2xl font-bold tracking-widest text-white mt-1">{passData.passCode}</p>
                </div>
              </div>
            </div>

            {(aadhaarUrl || aadhaarPdfCanvas) && (
              <div className="bg-gradient-to-br from-[#1a1a2e] to-[#16213e] border border-[#C9A84C]/30 rounded-2xl overflow-hidden">
                <div className="px-5 pt-4 pb-2">
                  <h3 className="text-[#C9A84C] text-xs font-semibold tracking-widest uppercase">Aadhaar Card</h3>
                  <p className="text-gray-500 text-[10px] mt-1">Pinch to zoom • Drag to pan</p>
                </div>
                <div
                  className="overflow-hidden touch-none cursor-grab active:cursor-grabbing"
                  style={{ maxHeight: "60vh" }}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  onWheel={handleWheel}
                >
                  <img
                    src={aadhaarUrl || aadhaarPdfCanvas || ""}
                    alt="Aadhaar Card"
                    className="w-full"
                    style={{
                      transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
                      transformOrigin: "center center",
                      transition: isDragging.current ? "none" : "transform 0.1s ease-out",
                    }}
                    draggable={false}
                  />
                </div>
                {scale > 1 && (
                  <button
                    onClick={() => { setScale(1); setTranslate({ x: 0, y: 0 }); }}
                    className="w-full py-2 text-[#C9A84C] text-xs tracking-widest uppercase hover:bg-[#C9A84C]/10 transition-colors"
                  >
                    Reset Zoom
                  </button>
                )}
              </div>
            )}

            {(collegeIdUrl || collegeIdPdfCanvas) && (
              <div className="bg-gradient-to-br from-[#1a1a2e] to-[#16213e] border border-blue-500/30 rounded-2xl overflow-hidden">
                <div className="px-5 pt-4 pb-2">
                  <h3 className="text-blue-400 text-xs font-semibold tracking-widest uppercase">College ID Card</h3>
                </div>
                <div className="overflow-hidden" style={{ maxHeight: "50vh" }}>
                  <img
                    src={collegeIdUrl || collegeIdPdfCanvas || ""}
                    alt="College ID Card"
                    className="w-full"
                    draggable={false}
                  />
                </div>
              </div>
            )}

            <button
              onClick={startScanner}
              className="w-full bg-[#C9A84C] text-black font-bold py-3 rounded-xl text-lg hover:bg-[#d4b85c] transition-colors"
            >
              Rescan
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
