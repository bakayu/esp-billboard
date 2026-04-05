import { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";

const W = 32;
const H = 16;
const SCALE = 20; // Bigger editor and preview
const SERIAL_BAUD = 115200;
const CHUNK = 128;
const HISTORY_LIMIT = 120;

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

  // Keep original uploaded image so fit mode can be toggled live
  const [loadedImage, setLoadedImage] = useState(null);

  const canUseSerial = useMemo(
    () => typeof navigator !== "undefined" && "serial" in navigator,
    [],
  );

  const canUndo = undoStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;
  const hasUploadedImage = !!loadedImage;

  useEffect(() => {
    pixelsRef.current = pixels;
  }, [pixels]);

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

  function undo() {
    if (!undoStackRef.current.length) return;
    redoStackRef.current.push(clonePixels(pixelsRef.current));
    const prev = undoStackRef.current.pop();
    setPixels(prev);
    setStatus("Undo");
    bumpHistory();
  }

  function redo() {
    if (!redoStackRef.current.length) return;
    undoStackRef.current.push(clonePixels(pixelsRef.current));
    const next = redoStackRef.current.pop();
    setPixels(next);
    setStatus("Redo");
    bumpHistory();
  }

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
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
          if (txt.trim()) setStatus("ESP: " + txt.trim());
        }
      }
    } catch {
      setStatus("Serial read loop ended");
    }
  }

  async function connectSerial() {
    if (!canUseSerial) {
      setStatus("Web Serial not supported in this browser");
      return;
    }

    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: SERIAL_BAUD });

      const writer = port.writable.getWriter();
      const reader = port.readable.getReader();

      portRef.current = port;
      writerRef.current = writer;
      readerRef.current = reader;

      setStatus("ESP connected");
      startReadLoop();
    } catch (err) {
      setStatus("Connect failed: " + String(err));
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

      setStatus("Disconnected");
    } catch (err) {
      setStatus("Disconnect error: " + String(err));
    }
  }

  async function sendToEsp() {
    if (!writerRef.current) {
      setStatus("Connect ESP first");
      return;
    }

    try {
      const packet = pixelsToPacketF888(pixels);
      for (let i = 0; i < packet.length; i += CHUNK) {
        await writerRef.current.write(packet.slice(i, i + CHUNK));
      }
      setStatus("Frame sent (" + packet.length + " bytes)");
    } catch (err) {
      setStatus("Send failed: " + String(err));
    }
  }

  return (
    <div className="app">
      <h1>P10 Pixel Portal (32x16)</h1>

      <div className="toolbar">
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

        <label>
          Draw color
          <input
            type="color"
            value={drawColor}
            onChange={(e) => setDrawColor(e.target.value)}
            disabled={tool !== "draw"}
          />
        </label>

        <label>
          Fit mode
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
            <option value="crop">crop</option>
            <option value="contain">contain</option>
          </select>
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
      </div>

      <div className="layout">
        <div className="panel">
          <h2>Editor</h2>
          <div className="panel-content">
            <canvas
              ref={canvasRef}
              width={W * SCALE}
              height={H * SCALE}
              className="editor-canvas"
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

      <div className="serial-row">
        <button onClick={connectSerial}>
          <Plug size={16} />
          Connect ESP
        </button>
        <button onClick={sendToEsp}>
          <Send size={16} />
          Upload preview to ESP
        </button>
        <button onClick={disconnectSerial}>
          <X size={16} />
          Disconnect
        </button>
      </div>

      <p className="status">{status}</p>
      <p className="hint">Undo: Ctrl+Z | Redo: Ctrl+Shift+Z</p>
    </div>
  );
}
