import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pencil,
  Eraser,
  Undo2,
  Redo2,
  Upload,
  Send,
  Plug,
  X,
  Trash2,
  ChevronDown,
  ShieldCheck,
  SlidersHorizontal,
  LoaderCircle,
  Wallet,
} from "lucide-react";

let web3ModulePromise = null;

async function loadWeb3() {
  if (!web3ModulePromise) {
    web3ModulePromise = import("@solana/web3.js");
  }
  return web3ModulePromise;
}

const W = 32;
const H = 16;
const SCALE = 20; // Bigger editor and preview
const SERIAL_BAUD = 115200;
const CHUNK = 128;
const HISTORY_LIMIT = 120;
const MODERATION_URL = import.meta.env.VITE_MODERATION_URL || "/api/moderate";
const MODERATION_TIMEOUT_MS = Number(
  import.meta.env.VITE_MODERATION_TIMEOUT_MS || "20000",
);
const MODERATION_MIN_SCORE = Number(
  import.meta.env.VITE_MODERATION_MIN_SCORE || "0.28",
);
const MODERATION_MARGIN = Number(
  import.meta.env.VITE_MODERATION_MARGIN || "0.08",
);
const SOLANA_REQUIRED =
  String(import.meta.env.VITE_SOLANA_REQUIRED || "true").toLowerCase() !==
  "false";
const SOLANA_RPC_URL =
  import.meta.env.VITE_SOLANA_RPC_URL || "http://127.0.0.1:8899";
const SOLANA_PROGRAM_ID = import.meta.env.VITE_SOLANA_PROGRAM_ID || "";
const SOLANA_COMMITMENT = import.meta.env.VITE_SOLANA_COMMITMENT || "confirmed";
const HARD_DEFAULT_LAMPORTS_PER_PIXEL = Number(
  import.meta.env.VITE_DEFAULT_LAMPORTS_PER_PIXEL || "2000",
);
const DEFAULT_LAMPORTS_PER_PIXEL =
  Number.isFinite(HARD_DEFAULT_LAMPORTS_PER_PIXEL) &&
  HARD_DEFAULT_LAMPORTS_PER_PIXEL > 0
    ? Math.floor(HARD_DEFAULT_LAMPORTS_PER_PIXEL)
    : 2000;

const MODERATION_CATEGORIES = [
  {
    key: "nudity",
    label: "Nudity",
  },
  {
    key: "gore",
    label: "Gore",
  },
  {
    key: "guns",
    label: "Guns",
  },
  {
    key: "drugs",
    label: "Drugs",
  },
  {
    key: "alcohol",
    label: "Alcohol",
  },
  {
    key: "violence",
    label: "Violence",
  },
];

const POLICY_PRESETS = {
  strict: {
    nudity: 0.18,
    gore: 0.2,
    guns: 0.2,
    drugs: 0.2,
    alcohol: 0.22,
    violence: 0.2,
  },
  balanced: {
    nudity: 0.26,
    gore: 0.28,
    guns: 0.27,
    drugs: 0.27,
    alcohol: 0.3,
    violence: 0.28,
  },
  relaxed: {
    nudity: 0.36,
    gore: 0.38,
    guns: 0.36,
    drugs: 0.36,
    alcohol: 0.4,
    violence: 0.38,
  },
};

function getPresetThresholds(name) {
  const preset = POLICY_PRESETS[name] || POLICY_PRESETS.strict;
  return { ...preset };
}

function svgCursor(svg, x, y, fallback) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
}

const DRAW_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M2 18l4-1 9-9-3-3-9 9-1 4z" fill="#111" stroke="#fff" stroke-width="1.3"/><path d="M11 3l3 3" stroke="#fff" stroke-width="1.3"/></svg>',
  2,
  18,
  "crosshair",
);

const ERASE_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><rect x="2" y="7" width="11" height="9" rx="2" transform="rotate(-25 2 7)" fill="#111" stroke="#fff" stroke-width="1.3"/><path d="M12.8 12.5h5" stroke="#fff" stroke-width="1.3"/></svg>',
  3,
  17,
  "cell",
);

const DEFAULT_MODERATION = {
  state: "idle",
  scores: null,
  blocked: [],
  reason: "Not checked",
  source: "none",
};

function makeBlackPixels() {
  const arr = [];
  for (let i = 0; i < W * H; i++) arr.push([0, 0, 0]);
  return arr;
}

function clonePixels(src) {
  return src.map((p) => [p[0], p[1], p[2]]);
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fitImageTo32x16(img, mode, pixelArtUpload) {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");

  ctx.imageSmoothingEnabled = !pixelArtUpload;
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, W, H);

  const srcW = img.width;
  const srcH = img.height;
  const srcAR = srcW / srcH;
  const dstAR = W / H;

  if (mode === "crop") {
    let sx = 0;
    let sy = 0;
    let sw = srcW;
    let sh = srcH;

    if (srcAR > dstAR) {
      sw = Math.round(srcH * dstAR);
      sx = Math.round((srcW - sw) / 2);
    } else {
      sh = Math.round(srcW / dstAR);
      sy = Math.round((srcH - sh) / 2);
    }

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  } else {
    let dw = W;
    let dh = H;

    if (srcAR > dstAR) {
      dh = Math.round(W / srcAR);
    } else {
      dw = Math.round(H * srcAR);
    }

    const dx = Math.round((W - dw) / 2);
    const dy = Math.round((H - dh) / 2);

    ctx.drawImage(img, 0, 0, srcW, srcH, dx, dy, dw, dh);
  }

  return c;
}

function pixelsToPacketF888(pixels) {
  const payloadLen = W * H * 3;
  const packet = new Uint8Array(6 + payloadLen);

  packet[0] = 70; // F
  packet[1] = 56; // 8
  packet[2] = 56; // 8
  packet[3] = 56; // 8
  packet[4] = payloadLen & 255;
  packet[5] = (payloadLen >> 8) & 255;

  let p = 6;
  for (let i = 0; i < pixels.length; i++) {
    const px = pixels[i];
    packet[p++] = px[0];
    packet[p++] = px[1];
    packet[p++] = px[2];
  }

  return packet;
}

function frameHash(pixels) {
  let h = 2166136261;
  for (let i = 0; i < pixels.length; i++) {
    h ^= pixels[i][0];
    h = Math.imul(h, 16777619);
    h ^= pixels[i][1];
    h = Math.imul(h, 16777619);
    h ^= pixels[i][2];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pixelsToPngDataUrl(pixels) {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(W, H);

  for (let i = 0; i < pixels.length; i++) {
    const idx = i * 4;
    img.data[idx + 0] = pixels[i][0];
    img.data[idx + 1] = pixels[i][1];
    img.data[idx + 2] = pixels[i][2];
    img.data[idx + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

function evaluateScores(scores, thresholds) {
  const blocked = [];

  for (const c of MODERATION_CATEGORIES) {
    const score = scores[c.key] || 0;
    const strongestOther = MODERATION_CATEGORIES.filter((o) => o.key !== c.key)
      .map((o) => scores[o.key] || 0)
      .reduce((max, v) => (v > max ? v : max), 0);

    const threshold = Math.max(MODERATION_MIN_SCORE, thresholds[c.key] || 0);
    const marginFromOther = score - strongestOther;
    const requiredMargin = c.key === "alcohol" ? 0 : MODERATION_MARGIN;
    if (score >= threshold && marginFromOther >= requiredMargin) {
      blocked.push(c.key);
    }
  }

  return {
    safe: blocked.length === 0,
    blocked,
  };
}

function prettyCategoryList(keys) {
  if (!keys || !keys.length) return "none";
  return keys
    .map(
      (key) => MODERATION_CATEGORIES.find((c) => c.key === key)?.label || key,
    )
    .join(", ");
}

function normalizedThresholds(input) {
  const out = {};
  for (const c of MODERATION_CATEGORIES) {
    const raw = Number(input?.[c.key]);
    if (Number.isFinite(raw)) {
      out[c.key] = Math.max(0, Math.min(1, raw));
    }
  }
  return out;
}

function countUsedPixels(pixels) {
  let count = 0;
  for (const p of pixels) {
    if (p[0] !== 0 || p[1] !== 0 || p[2] !== 0) count += 1;
  }
  return count;
}

function shortAddress(address) {
  if (!address) return "disconnected";
  if (address.length < 12) return address;
  return address.slice(0, 4) + "..." + address.slice(-4);
}

function formatLamports(lamports) {
  const n = Number(lamports || 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString();
}

function formatSol(lamports) {
  const n = Number(lamports || 0) / 1_000_000_000;
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(6);
}

function readU64Le(data, offset) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

function parseConfigAccountData(data, PublicKeyCtor) {
  // Anchor layout: 8 discriminator + authority 32 + treasury 32 + price 8 + bump 1
  if (!data || data.length < 81) {
    throw new Error("Config account not found or has invalid size");
  }
  const treasury = new PublicKeyCtor(data.slice(40, 72));
  const lamportsPerPixel = readU64Le(data, 72);
  const bump = data[80];
  return { treasury, lamportsPerPixel, bump };
}

function toU16Le(value) {
  const out = new Uint8Array(2);
  const view = new DataView(out.buffer);
  view.setUint16(0, value, true);
  return out;
}

async function anchorDiscriminator(methodName) {
  const bytes = new TextEncoder().encode("global:" + methodName);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash).slice(0, 8);
}

async function payPerPixelIxData(pixelCount) {
  const discriminator = await anchorDiscriminator("pay_per_pixel");
  const arg = toU16Le(pixelCount);
  const data = new Uint8Array(10);
  data.set(discriminator, 0);
  data.set(arg, 8);
  return data;
}

function getWalletProvider() {
  if (typeof window === "undefined") return null;
  return window.phantom?.solana || window.solana || null;
}

async function moderateViaApi(pixels, thresholds) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("moderation-timeout"),
    MODERATION_TIMEOUT_MS,
  );

  const safeThresholds = normalizedThresholds(thresholds);

  try {
    const res = await fetch(MODERATION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        width: W,
        height: H,
        imageDataUrl: pixelsToPngDataUrl(pixels),
        thresholds: safeThresholds,
      }),
    });

    if (!res.ok) {
      let detail = "";
      try {
        const problem = await res.json();
        detail = problem?.detail
          ? typeof problem.detail === "string"
            ? problem.detail
            : JSON.stringify(problem.detail)
          : JSON.stringify(problem);
      } catch {
        try {
          detail = await res.text();
        } catch {
          detail = "";
        }
      }

      throw new Error(
        "Moderation API HTTP " +
          String(res.status) +
          (detail ? ": " + detail : ""),
      );
    }

    const data = await res.json();
    const scores = {};
    for (const c of MODERATION_CATEGORIES) {
      const raw = data?.scores?.[c.key] ?? data?.[c.key] ?? 0;
      const score = Number(raw);
      scores[c.key] = Number.isFinite(score)
        ? Math.max(0, Math.min(1, score))
        : 0;
    }

    const evalResult = evaluateScores(scores, thresholds);
    const blockedList = prettyCategoryList(evalResult.blocked);

    return {
      safe: evalResult.safe,
      scores,
      blocked: evalResult.blocked,
      reason:
        data.reason ||
        (evalResult.safe
          ? "No blocked categories above threshold"
          : "Blocked categories: " + blockedList),
      source: "api",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default function App() {
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);

  const portRef = useRef(null);
  const writerRef = useRef(null);
  const readerRef = useRef(null);
  const readAbortRef = useRef(false);

  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const pixelsRef = useRef(makeBlackPixels());

  const [pixels, setPixels] = useState(makeBlackPixels);
  const [drawColor, setDrawColor] = useState("#ff5500");
  const [fitMode, setFitMode] = useState("crop");
  const [pixelArtUpload, setPixelArtUpload] = useState(true);
  const [previewUrl, setPreviewUrl] = useState("");
  const [status, setStatus] = useState("Idle");
  const [isDrawing, setIsDrawing] = useState(false);
  const [tool, setTool] = useState("draw");
  const [historyTick, setHistoryTick] = useState(0);
  const [serialState, setSerialState] = useState("disconnected");
  const [isSending, setIsSending] = useState(false);
  const [sendProgress, setSendProgress] = useState(0);
  const [requireModeration, setRequireModeration] = useState(true);
  const [moderation, setModeration] = useState(DEFAULT_MODERATION);
  const [policyPreset, setPolicyPreset] = useState("strict");
  const [categoryThresholds, setCategoryThresholds] = useState(() =>
    getPresetThresholds("strict"),
  );
  const [strictModeration, setStrictModeration] = useState(false);
  const [showPolicyPanel, setShowPolicyPanel] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [isPaying, setIsPaying] = useState(false);
  const [lastPaymentSig, setLastPaymentSig] = useState("");
  const [solanaConfig, setSolanaConfig] = useState(null);
  const [solanaStatus, setSolanaStatus] = useState("Solana not initialized");
  const [web3, setWeb3] = useState(null);
  const [connection, setConnection] = useState(null);
  const [programId, setProgramId] = useState(null);
  const [toasts, setToasts] = useState([]);
  const toastSeqRef = useRef(0);

  // Keep original uploaded image so fit mode can be toggled live
  const [loadedImage, setLoadedImage] = useState(null);
  const lastModeratedHashRef = useRef(null);

  const walletProvider = useMemo(() => getWalletProvider(), []);

  const canUseSerial = useMemo(
    () => typeof navigator !== "undefined" && "serial" in navigator,
    [],
  );

  const blockedPretty = useMemo(
    () => prettyCategoryList(moderation.blocked),
    [moderation.blocked],
  );
  const usedPixels = useMemo(() => countUsedPixels(pixels), [pixels]);
  const priceInfo = useMemo(() => {
    const value = Number(solanaConfig?.lamportsPerPixel);
    if (Number.isFinite(value) && value > 0) {
      return { lamports: value, source: "on-chain" };
    }
    return { lamports: DEFAULT_LAMPORTS_PER_PIXEL, source: "local" };
  }, [solanaConfig?.lamportsPerPixel]);
  const estimatedLamports = useMemo(() => {
    return usedPixels * priceInfo.lamports;
  }, [priceInfo.lamports, usedPixels]);

  const editorCursor = tool === "erase" ? ERASE_CURSOR : DRAW_CURSOR;

  const canUndo = undoStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;
  const hasUploadedImage = !!loadedImage;

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message, tone = "info", ttlMs = 3200) => {
      const id = toastSeqRef.current + 1;
      toastSeqRef.current = id;
      setToasts((prev) => [...prev, { id, message, tone }]);

      setTimeout(() => {
        dismissToast(id);
      }, ttlMs);
    },
    [dismissToast],
  );

  const fetchSolanaConfig = useCallback(async () => {
    if (!SOLANA_REQUIRED) return null;
    if (!web3 || !connection) {
      throw new Error("Solana client not loaded yet");
    }
    if (!programId) {
      throw new Error("Missing or invalid VITE_SOLANA_PROGRAM_ID");
    }

    const [configPda] = web3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("config")],
      programId,
    );

    const info = await connection.getAccountInfo(configPda, SOLANA_COMMITMENT);
    if (!info?.data) {
      throw new Error("Protocol config account not found on current cluster");
    }

    const parsed = parseConfigAccountData(info.data, web3.PublicKey);
    const next = {
      configPda,
      treasury: parsed.treasury,
      lamportsPerPixel: Number(parsed.lamportsPerPixel),
    };
    setSolanaConfig(next);
    setSolanaStatus(
      "Config loaded: " +
        formatLamports(next.lamportsPerPixel) +
        " lamports/pixel",
    );
    return next;
  }, [connection, programId, web3]);

  const connectWallet = useCallback(async () => {
    if (!SOLANA_REQUIRED) return null;
    if (!walletProvider) {
      throw new Error("No Solana wallet detected. Install Phantom/Solflare.");
    }

    const resp = await walletProvider.connect();
    const pk = resp?.publicKey || walletProvider.publicKey;
    if (!pk) {
      throw new Error("Wallet connection did not return a public key");
    }

    const address = pk.toBase58();
    setWalletAddress(address);
    setSolanaStatus("Wallet connected: " + shortAddress(address));
    return pk;
  }, [walletProvider]);

  const payForCurrentFrame = useCallback(async () => {
    if (!SOLANA_REQUIRED) return true;
    if (usedPixels <= 0) {
      setStatus("Draw at least one colored pixel before upload");
      return false;
    }
    if (!walletProvider) {
      setStatus("Install a Solana wallet (Phantom/Solflare)");
      return false;
    }
    if (!web3 || !connection) {
      setStatus("Solana client is still loading");
      return false;
    }
    if (!programId) {
      setStatus("Missing VITE_SOLANA_PROGRAM_ID");
      return false;
    }

    try {
      setIsPaying(true);
      setSolanaStatus("Preparing payment transaction");

      const payer = walletProvider.publicKey || (await connectWallet());
      if (!payer) throw new Error("Wallet unavailable after connect");

      let cfg = solanaConfig;
      if (!cfg) {
        cfg = await fetchSolanaConfig();
      }
      if (!cfg) throw new Error("Protocol config unavailable");

      const price = Number(cfg.lamportsPerPixel || 0);
      const amountLamports = price * usedPixels;
      if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
        throw new Error("Invalid on-chain price configuration");
      }

      const ixData = await payPerPixelIxData(usedPixels);
      const ix = new web3.TransactionInstruction({
        programId,
        keys: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: cfg.configPda, isSigner: false, isWritable: false },
          { pubkey: cfg.treasury, isSigner: false, isWritable: true },
          {
            pubkey: web3.SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: ixData,
      });

      const tx = new web3.Transaction().add(ix);
      tx.feePayer = payer;

      const latest = await connection.getLatestBlockhash(SOLANA_COMMITMENT);
      tx.recentBlockhash = latest.blockhash;

      setSolanaStatus(
        "Awaiting wallet confirmation for " +
          formatLamports(amountLamports) +
          " lamports",
      );
      const sent = await walletProvider.signAndSendTransaction(tx);
      const signature = typeof sent === "string" ? sent : sent?.signature;
      if (!signature) throw new Error("Wallet returned empty signature");

      await connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        SOLANA_COMMITMENT,
      );

      setLastPaymentSig(signature);
      setSolanaStatus("Payment confirmed: " + signature.slice(0, 10) + "...");
      return true;
    } catch (err) {
      setSolanaStatus("Payment failed: " + String(err));
      setStatus("Payment failed, upload blocked");
      return false;
    } finally {
      setIsPaying(false);
    }
  }, [
    connectWallet,
    connection,
    fetchSolanaConfig,
    programId,
    solanaConfig,
    usedPixels,
    web3,
    walletProvider,
  ]);

  useEffect(() => {
    pixelsRef.current = pixels;
  }, [pixels]);

  useEffect(() => {
    if (!SOLANA_REQUIRED) return;

    let active = true;

    (async () => {
      try {
        setSolanaStatus("Loading Solana client");
        const web3Module = await loadWeb3();
        if (!active) return;

        setWeb3(web3Module);
        setConnection(
          new web3Module.Connection(SOLANA_RPC_URL, SOLANA_COMMITMENT),
        );

        try {
          setProgramId(
            SOLANA_PROGRAM_ID
              ? new web3Module.PublicKey(SOLANA_PROGRAM_ID)
              : null,
          );
        } catch {
          setProgramId(null);
        }
      } catch (err) {
        if (!active) return;
        setSolanaStatus("Failed to load Solana client: " + String(err));
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!SOLANA_REQUIRED) {
      setSolanaStatus("Solana payment gate disabled");
      return;
    }

    if (!web3 || !connection) {
      setSolanaStatus("Loading Solana client");
      return;
    }

    if (!programId) {
      setSolanaStatus("Missing VITE_SOLANA_PROGRAM_ID");
      return;
    }

    fetchSolanaConfig().catch((err) => {
      setSolanaStatus(
        "Config load failed, using hardcoded price: " + String(err),
      );
    });

    if (!walletProvider) {
      setWalletAddress("");
      return;
    }

    const existing = walletProvider.publicKey?.toBase58?.();
    if (existing) setWalletAddress(existing);

    const onConnect = (pk) => {
      const address =
        pk?.toBase58?.() || walletProvider.publicKey?.toBase58?.();
      if (address) setWalletAddress(address);
    };
    const onDisconnect = () => {
      setWalletAddress("");
    };

    walletProvider.on?.("connect", onConnect);
    walletProvider.on?.("disconnect", onDisconnect);
    walletProvider.on?.("accountChanged", onConnect);

    return () => {
      walletProvider.off?.("connect", onConnect);
      walletProvider.off?.("disconnect", onDisconnect);
      walletProvider.off?.("accountChanged", onConnect);
    };
  }, [connection, fetchSolanaConfig, programId, walletProvider, web3]);

  useEffect(() => {
    const currentHash = frameHash(pixels);
    if (
      lastModeratedHashRef.current !== null &&
      lastModeratedHashRef.current !== currentHash &&
      moderation.state !== "idle" &&
      moderation.state !== "checking"
    ) {
      setModeration({
        state: "idle",
        scores: null,
        blocked: [],
        reason: "Frame changed, safety check required",
        source: moderation.source,
      });
    }
  }, [pixels, moderation.state, moderation.source]);

  function bumpHistory() {
    setHistoryTick((v) => v + 1);
  }

  function pushUndoSnapshot() {
    undoStackRef.current.push(clonePixels(pixelsRef.current));
    if (undoStackRef.current.length > HISTORY_LIMIT) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    bumpHistory();
  }

  const undo = useCallback(() => {
    if (!undoStackRef.current.length) return;
    redoStackRef.current.push(clonePixels(pixelsRef.current));
    const prev = undoStackRef.current.pop();
    setPixels(prev);
    setStatus("Undo");
    bumpHistory();
  }, []);

  const redo = useCallback(() => {
    if (!redoStackRef.current.length) return;
    undoStackRef.current.push(clonePixels(pixelsRef.current));
    const next = redoStackRef.current.pop();
    setPixels(next);
    setStatus("Redo");
    bumpHistory();
  }, []);

  function applyImageToPixels(img, statusText = "") {
    const fitted = fitImageTo32x16(img, fitMode, pixelArtUpload);
    const ctx = fitted.getContext("2d");
    const data = ctx.getImageData(0, 0, W, H).data;

    const next = [];
    for (let i = 0; i < W * H; i++) {
      next.push([data[i * 4 + 0], data[i * 4 + 1], data[i * 4 + 2]]);
    }

    setPixels(next);
    if (statusText) setStatus(statusText);
  }

  // Re-apply same uploaded image whenever fit mode or pixel-art toggle changes
  useEffect(() => {
    if (!loadedImage) return;
    applyImageToPixels(loadedImage, "Image fit updated");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitMode, pixelArtUpload, loadedImage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = pixels[y * W + x];
        ctx.fillStyle = "rgb(" + px[0] + "," + px[1] + "," + px[2] + ")";
        ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
      }
    }

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    for (let x = 0; x <= W; x++) {
      ctx.beginPath();
      ctx.moveTo(x * SCALE + 0.5, 0);
      ctx.lineTo(x * SCALE + 0.5, H * SCALE);
      ctx.stroke();
    }
    for (let y = 0; y <= H; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * SCALE + 0.5);
      ctx.lineTo(W * SCALE, y * SCALE + 0.5);
      ctx.stroke();
    }

    const p = document.createElement("canvas");
    p.width = W;
    p.height = H;
    const pctx = p.getContext("2d");
    const img = pctx.createImageData(W, H);

    for (let i = 0; i < pixels.length; i++) {
      const idx = i * 4;
      img.data[idx + 0] = pixels[i][0];
      img.data[idx + 1] = pixels[i][1];
      img.data[idx + 2] = pixels[i][2];
      img.data[idx + 3] = 255;
    }

    pctx.putImageData(img, 0, 0);

    const up = document.createElement("canvas");
    up.width = W * SCALE;
    up.height = H * SCALE;
    const uctx = up.getContext("2d");
    uctx.imageSmoothingEnabled = false;
    uctx.drawImage(p, 0, 0, up.width, up.height);
    setPreviewUrl(up.toDataURL("image/png"));
  }, [pixels, historyTick]);

  useEffect(() => {
    function onKeyDown(e) {
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      if (!ctrlOrMeta) return;

      const key = e.key.toLowerCase();
      if (key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }
      if (key === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        redo();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, undo]);

  function setPixel(x, y, rgb) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    setPixels((prev) => {
      const idx = y * W + x;
      const old = prev[idx];
      if (old[0] === rgb[0] && old[1] === rgb[1] && old[2] === rgb[2]) {
        return prev;
      }
      const next = prev.slice();
      next[idx] = rgb;
      return next;
    });
  }

  function posToPixel(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const px = Math.floor((e.clientX - rect.left) / (rect.width / W));
    const py = Math.floor((e.clientY - rect.top) / (rect.height / H));
    return [px, py];
  }

  function paintAtEvent(e) {
    const rgb = tool === "erase" ? [0, 0, 0] : hexToRgb(drawColor);
    const [x, y] = posToPixel(e);
    setPixel(x, y, rgb);
  }

  function handlePointerDown(e) {
    pushUndoSnapshot();
    setIsDrawing(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    paintAtEvent(e);
  }

  function handlePointerMove(e) {
    if (!isDrawing) return;
    paintAtEvent(e);
  }

  function handlePointerUp(e) {
    setIsDrawing(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  function clearAll() {
    pushUndoSnapshot();
    setPixels(makeBlackPixels());
    setLoadedImage(null); // disable fit controls until next upload
    setStatus("Canvas cleared");
  }

  function setThresholdPreset(preset) {
    setPolicyPreset(preset);
    if (preset !== "custom") {
      setCategoryThresholds(getPresetThresholds(preset));
    }
  }

  async function loadImageToCanvas(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();

      pushUndoSnapshot();
      setLoadedImage(img);
      applyImageToPixels(img, "Image loaded to canvas");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function startReadLoop() {
    if (!readerRef.current) return;
    const decoder = new TextDecoder();
    readAbortRef.current = false;

    try {
      while (!readAbortRef.current) {
        const r = await readerRef.current.read();
        if (r.done) break;
        if (r.value) {
          const txt = decoder.decode(r.value);
          if (txt.trim()) setStatus("Gateway: " + txt.trim());
        }
      }
    } catch {
      if (!readAbortRef.current) setStatus("Serial read loop ended");
    } finally {
      if (!readAbortRef.current) setSerialState("disconnected");
    }
  }

  async function connectSerial() {
    if (!canUseSerial) {
      setStatus("Web Serial not supported in this browser");
      pushToast("Web Serial not supported in this browser", "error", 4200);
      return;
    }

    if (serialState === "connecting" || serialState === "connected") {
      setStatus("Gateway already connected");
      return;
    }

    setSerialState("connecting");

    try {
      const existingPorts = await navigator.serial.getPorts();
      const port = existingPorts[0] || (await navigator.serial.requestPort());
      await port.open({ baudRate: SERIAL_BAUD });

      const writer = port.writable.getWriter();
      const reader = port.readable.getReader();

      portRef.current = port;
      writerRef.current = writer;
      readerRef.current = reader;

      setSerialState("connected");
      setStatus("Gateway connected");
      pushToast("ESP gateway connected", "success");
      startReadLoop();
    } catch (err) {
      setSerialState("disconnected");
      setStatus("Connect failed: " + String(err));
      pushToast("ESP connection failed", "error");
    }
  }

  async function disconnectSerial() {
    try {
      readAbortRef.current = true;

      if (readerRef.current) {
        await readerRef.current.cancel().catch(() => {});
        readerRef.current.releaseLock();
        readerRef.current = null;
      }

      if (writerRef.current) {
        writerRef.current.releaseLock();
        writerRef.current = null;
      }

      if (portRef.current) {
        await portRef.current.close().catch(() => {});
        portRef.current = null;
      }

      setSerialState("disconnected");
      setStatus("Disconnected");
      pushToast("ESP gateway disconnected", "info");
    } catch (err) {
      setStatus("Disconnect error: " + String(err));
      pushToast("ESP disconnect failed", "error");
    }
  }

  async function runModeration() {
    const snapshot = clonePixels(pixelsRef.current);
    const hash = frameHash(snapshot);

    setModeration({
      state: "checking",
      scores: null,
      blocked: [],
      reason: "Checking moderation policy",
      source: "pending",
    });

    try {
      const result = await moderateViaApi(snapshot, categoryThresholds);

      lastModeratedHashRef.current = hash;
      setModeration({
        state: result.safe ? "safe" : "blocked",
        scores: result.scores,
        blocked: result.blocked,
        reason: result.reason,
        source: result.source,
      });

      if (!result.safe) {
        setStatus("Blocked by moderation policy");
        pushToast("Moderation blocked this frame", "error", 4200);
        return false;
      }

      setStatus("Moderation check passed");
      return true;
    } catch (err) {
      if (!strictModeration) {
        setModeration({
          state: "safe",
          scores: null,
          blocked: [],
          reason: "Moderation unavailable, allowed because strict mode is off",
          source: "bypass",
        });
        setStatus("Moderation unavailable, strict mode disabled");
        return true;
      }

      setModeration({
        state: "error",
        scores: null,
        blocked: [],
        reason:
          err?.name === "AbortError"
            ? "Moderation request timed out after " +
              String(Math.round(MODERATION_TIMEOUT_MS / 1000)) +
              "s"
            : "Moderation failed: " + String(err),
        source: "none",
      });
      setStatus("Moderation failed, send blocked");
      pushToast("Moderation failed, upload blocked", "error", 4200);
      return false;
    }
  }

  async function sendToEsp() {
    if (!writerRef.current || serialState !== "connected") {
      setStatus("Connect gateway first");
      return;
    }

    if (isSending || isPaying) return;

    if (requireModeration) {
      const currentHash = frameHash(pixelsRef.current);
      const alreadyApproved =
        moderation.state === "safe" &&
        lastModeratedHashRef.current === currentHash;

      if (!alreadyApproved) {
        const ok = await runModeration();
        if (!ok) return;
      }
    }

    if (SOLANA_REQUIRED) {
      const paid = await payForCurrentFrame();
      if (!paid) return;
    }

    try {
      setIsSending(true);
      setSendProgress(0);

      const packet = pixelsToPacketF888(pixelsRef.current);
      const totalChunks = Math.ceil(packet.length / CHUNK);

      for (let i = 0; i < packet.length; i += CHUNK) {
        await writerRef.current.write(packet.slice(i, i + CHUNK));
        const sentChunks = Math.floor(i / CHUNK) + 1;
        setSendProgress(Math.round((sentChunks / totalChunks) * 100));
      }
      setStatus("Frame sent to gateway (" + packet.length + " bytes)");
      pushToast("Frame uploaded to gateway", "success");
    } catch (err) {
      setStatus("Send failed: " + String(err));
      pushToast("Frame upload failed", "error");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Pixel Portal</h1>
        <p className="subtitle">
          Draw, moderate, pay per pixel on Solana, then stream to gateway
        </p>
        <div className="status-pills">
          <span className="pill">Gateway: {serialState}</span>
          <span className="pill">Moderation: {moderation.state}</span>
          {SOLANA_REQUIRED ? (
            <span className="pill">Wallet: {shortAddress(walletAddress)}</span>
          ) : null}
        </div>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          if (f) loadImageToCanvas(f);
          e.target.value = "";
        }}
      />

      <section className="control-grid">
        <div className="control-card">
          <h2>Moderation</h2>
          <div className="card-row">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={requireModeration}
                onChange={(e) => setRequireModeration(e.target.checked)}
              />
              Moderation required
            </label>

            <button
              onClick={runModeration}
              disabled={moderation.state === "checking" || isSending}
            >
              {moderation.state === "checking" ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <ShieldCheck size={16} />
              )}
              {moderation.state === "checking" ? "Checking" : "Run moderation"}
            </button>

            <button
              className="secondary"
              onClick={() => setShowPolicyPanel((v) => !v)}
            >
              <SlidersHorizontal size={16} />
              {showPolicyPanel ? "Hide policy" : "Moderation policy"}
            </button>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={strictModeration}
                onChange={(e) => setStrictModeration(e.target.checked)}
              />
              Block if API check fails
            </label>
          </div>

          {showPolicyPanel ? (
            <div className="policy-panel">
              <div className="policy-header">
                <label className="field field-inline">
                  <span>Policy preset</span>
                  <div className="select-wrap">
                    <select
                      value={policyPreset}
                      onChange={(e) => setThresholdPreset(e.target.value)}
                    >
                      <option value="strict">Strict</option>
                      <option value="balanced">Balanced</option>
                      <option value="relaxed">Relaxed</option>
                      <option value="custom">Custom</option>
                    </select>
                    <ChevronDown size={14} />
                  </div>
                </label>
              </div>

              <div className="policy-grid">
                {MODERATION_CATEGORIES.map((cat) => (
                  <label className="policy-item" key={cat.key}>
                    <span>
                      {cat.label} threshold:{" "}
                      {categoryThresholds[cat.key].toFixed(2)}
                    </span>
                    <input
                      type="range"
                      min="0.05"
                      max="0.95"
                      step="0.01"
                      value={categoryThresholds[cat.key]}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        setPolicyPreset("custom");
                        setCategoryThresholds((prev) => ({
                          ...prev,
                          [cat.key]: value,
                        }));
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {SOLANA_REQUIRED ? (
          <div className="control-card">
            <h2>Solana Payment</h2>
            <div className="card-row">
              <button
                onClick={async () => {
                  try {
                    await connectWallet();
                  } catch (err) {
                    setStatus("Wallet connect failed: " + String(err));
                  }
                }}
                disabled={isPaying}
                className="secondary"
              >
                <Wallet size={16} />
                {walletAddress
                  ? "Wallet " + shortAddress(walletAddress)
                  : "Connect wallet"}
              </button>
            </div>
            <div className="stats-grid">
              <div className="stat">
                <span>Price per pixel</span>
                <strong>
                  {formatLamports(priceInfo.lamports)} lamports (
                  {priceInfo.source})
                </strong>
              </div>
              <div className="stat">
                <span>Used pixels</span>
                <strong>{usedPixels}</strong>
              </div>
              <div className="stat">
                <span>Estimated payment</span>
                <strong>
                  {formatLamports(estimatedLamports)} lamports (
                  {formatSol(estimatedLamports)} SOL)
                </strong>
              </div>
              <div className="stat">
                <span>Last signature</span>
                <strong>{lastPaymentSig || "none"}</strong>
              </div>
            </div>
          </div>
        ) : null}

        <div className="control-card">
          <h2>Gateway Upload</h2>
          <div className="card-row">
            <button
              onClick={connectSerial}
              disabled={
                serialState === "connecting" || serialState === "connected"
              }
            >
              <Plug size={16} />
              {serialState === "connecting"
                ? "Connecting..."
                : "Connect gateway"}
            </button>
            <button
              className="primary"
              onClick={sendToEsp}
              disabled={serialState !== "connected" || isSending || isPaying}
            >
              <Send size={16} />
              {isPaying
                ? "Waiting for wallet confirmation"
                : isSending
                  ? "Sending " + sendProgress + "%"
                  : "Upload frame to gateway"}
            </button>
            <button
              className="secondary"
              onClick={disconnectSerial}
              disabled={serialState === "disconnected"}
            >
              <X size={16} />
              Disconnect
            </button>
          </div>
        </div>
      </section>

      <section className="editor-workbench control-card">
        <h2>Canvas Tools</h2>
        <div className="tool-buttons">
          <button
            className={tool === "draw" ? "icon-btn active" : "icon-btn"}
            onClick={() => setTool("draw")}
            title="Draw tool"
          >
            <Pencil size={16} />
          </button>
          <button
            className={tool === "erase" ? "icon-btn active" : "icon-btn"}
            onClick={() => setTool("erase")}
            title="Eraser tool"
          >
            <Eraser size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={undo}
            title="Undo (Ctrl+Z)"
            disabled={!canUndo}
          >
            <Undo2 size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={redo}
            title="Redo (Ctrl+Shift+Z)"
            disabled={!canRedo}
          >
            <Redo2 size={16} />
          </button>
          <button className="icon-btn" onClick={clearAll} title="Clear canvas">
            <Trash2 size={16} />
          </button>
        </div>

        <div className="card-row">
          <label className="field">
            <span>Draw color</span>
            <input
              type="color"
              value={drawColor}
              onChange={(e) => setDrawColor(e.target.value)}
              disabled={tool !== "draw"}
            />
          </label>

          <label className="field">
            <span>Fit mode</span>
            <div className="select-wrap">
              <select
                value={fitMode}
                onChange={(e) => setFitMode(e.target.value)}
                disabled={!hasUploadedImage}
                title={
                  hasUploadedImage
                    ? "Change image fit mode"
                    : "Upload an image first"
                }
              >
                <option value="crop">Crop</option>
                <option value="contain">Contain</option>
              </select>
              <ChevronDown size={14} />
            </div>
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={pixelArtUpload}
              onChange={(e) => setPixelArtUpload(e.target.checked)}
              disabled={!hasUploadedImage}
            />
            Pixel-art upload
          </label>

          <button onClick={() => fileInputRef.current?.click()}>
            <Upload size={16} />
            Load image
          </button>
        </div>
      </section>

      <div className="layout">
        <div className="panel">
          <h2>Editor</h2>
          <div className="panel-content">
            <canvas
              ref={canvasRef}
              width={W * SCALE}
              height={H * SCALE}
              className="editor-canvas"
              style={{ cursor: editorCursor }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
            />
          </div>
        </div>

        <div className="panel">
          <h2>Preview</h2>
          <div className="panel-content">
            {previewUrl ? (
              <img className="preview" src={previewUrl} alt="32x16 preview" />
            ) : null}
          </div>
        </div>
      </div>

      <section className="status-board">
        <p className="status">{status}</p>
        <p className="hint">Protocol: {solanaStatus}</p>
        <p className="hint">Blocked categories: {blockedPretty}</p>
        <p className="hint">Safety note: {moderation.reason}</p>
        <p className="hint">Moderation API: {MODERATION_URL}</p>
        <p className="hint">Undo: Ctrl+Z | Redo: Ctrl+Shift+Z</p>
      </section>

      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={"toast toast--" + toast.tone}>
            <span>{toast.message}</span>
            <button
              className="toast-close"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
              title="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
