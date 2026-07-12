'use client';

import React, { useEffect, useRef, useState } from 'react';
import { VolumeX, Volume2, Maximize, AlertCircle, RefreshCw } from 'lucide-react';

interface PixelStreamPlayerProps {
  port: number;
  isSimulated?: boolean;
  onLog?: (message: string) => void;
}

function patchWebSocket() {
  if (typeof window === 'undefined') return;
  const NativeWebSocket = window.WebSocket;
  const OriginalWebSocket = NativeWebSocket as any;
  if ((OriginalWebSocket as any).__patched) return;

  function PatchedWebSocket(url: string, protocols?: string | string[]) {
    const ws = protocols !== undefined
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);

    const originalSend = ws.send.bind(ws);
    const queue: any[] = [];
    let ready = false;

    const origOnOpen = ws.onopen;
    ws.addEventListener('open', () => {
      ready = true;
      while (queue.length > 0) {
        const msg = queue.shift();
        try { originalSend(msg); } catch (e) { /* ignore */ }
      }
    });

    ws.send = function (data: any) {
      if (ready) {
        originalSend(data);
      } else {
        queue.push(data);
      }
    };

    return ws;
  }

  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
  (PatchedWebSocket as any).__patched = true;

  window.WebSocket = PatchedWebSocket as any;
}

export default function PixelStreamPlayer({ port, isSimulated, onLog }: PixelStreamPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<any>(null);
  const simIntervalRef = useRef<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (isSimulated) {
      setLoading(false);
      setConnected(true);
      onLog?.('Establishing WebSocket connection... (Simulation Mode)');
      const t1 = setTimeout(() => onLog?.('WebSocket connection opened (Simulated)'), 500);
      const t2 = setTimeout(
        () => onLog?.('Received WebRTC configuration from simulated server'),
        1000,
      );
      const t3 = setTimeout(
        () => onLog?.('WebRTC Audio/Video stream connected successfully! (Simulated)'),
        2000,
      );

      startSimulation();
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
        if (simIntervalRef.current) {
          cancelAnimationFrame(simIntervalRef.current);
        }
      };
    }

    patchWebSocket();

    const host = window.location.hostname || '127.0.0.1';
    const wsUrl = `ws://${host}:${port}`;
    onLog?.(`Establishing WebSocket to ${wsUrl}`);

    let active = true;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    function connectStream() {
      import('@epicgames-ps/lib-pixelstreamingfrontend-ue5.5').then(({ Config, PixelStreaming }) => {
        if (!active) return;

        try {
          const config = new Config({
            initialSettings: {
              AutoConnect: true,
              AutoPlayVideo: true,
              StartVideoMuted: true,
              ss: wsUrl,
            },
          });

          const overrides = {
            videoElementParent: containerRef.current || undefined,
          };

          const stream = new PixelStreaming(config, overrides);
          streamRef.current = stream;

          stream.addEventListener('webRtcConnecting', () => {
            onLog?.('WebRTC connection negotiating...');
          });

          stream.addEventListener('webRtcConnected', () => {
            console.log('WebRTC peer connection established');
            onLog?.('WebRTC peer connection established');
          });

          stream.addEventListener('videoInitialized', () => {
            setLoading(false);
            setConnected(true);
            retryCount = 0;
            console.log('Video stream initialized');
            onLog?.('WebRTC Audio/Video stream connected successfully!');

            const video = containerRef.current?.querySelector('video');
            if (video) {
              video.muted = isMuted;
            }
          });

          stream.addEventListener('webRtcDisconnected', () => {
            setConnected(false);
            console.log('Pixel Streaming closed');
            onLog?.('Pixel Streaming connection closed');
          });

          stream.addEventListener('webRtcFailed', () => {
            setConnected(false);
            setLoading(false);
            if (retryCount < MAX_RETRIES) {
              retryCount++;
              onLog?.(`WebRTC handshake failed. Retry ${retryCount}/${MAX_RETRIES}...`);
              setTimeout(() => {
                if (active) {
                  try { stream.disconnect(); } catch (e) { /* ignore */ }
                  streamRef.current = null;
                  connectStream();
                }
              }, RETRY_DELAY_MS);
            } else {
              setError('WebRTC connection handshake failed after retries');
              onLog?.('Error: WebRTC connection handshake failed');
            }
          });
        } catch (err: any) {
          console.error(err);
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            onLog?.(`Connection error: ${err.message}. Retry ${retryCount}/${MAX_RETRIES}...`);
            setTimeout(() => {
              if (active) connectStream();
            }, RETRY_DELAY_MS);
          } else {
            setError(err.message || 'Failed to connect to stream');
            onLog?.(`Error: ${err.message || 'Connection failed'}`);
            setLoading(false);
          }
        }
      });
    }

    connectStream();

    return () => {
      active = false;
      if (streamRef.current) {
        try {
          streamRef.current.disconnect();
        } catch (e) {
          // ignore
        }
        streamRef.current = null;
      }
    };
  }, [port, isSimulated]);

  const startSimulation = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    const particles: { x: number; y: number; z: number; color: string }[] = [];
    for (let i = 0; i < 100; i++) {
      particles.push({
        x: (Math.random() - 0.5) * 1000,
        y: (Math.random() - 0.5) * 1000,
        z: Math.random() * 1000,
        color: `hsl(${200 + Math.random() * 60}, 80%, 70%)`,
      });
    }

    const draw = () => {
      frame++;

      ctx.fillStyle = '#0b0c16';
      ctx.fillRect(0, 0, 1280, 720);

      ctx.strokeStyle = '#1e1b4b';
      ctx.lineWidth = 1;
      const centerY = 450;
      const speed = 2;
      const offset = (frame * speed) % 40;

      for (let y = centerY; y < 720; y += 20) {
        const animatedY = y + (offset * (y - centerY)) / 270;
        ctx.beginPath();
        ctx.moveTo(0, animatedY);
        ctx.lineTo(1280, animatedY);
        ctx.stroke();
      }

      const lineCount = 30;
      for (let i = 0; i <= lineCount; i++) {
        const xProgress = i / lineCount;
        const xOffset = (xProgress - 0.5) * 2000;
        ctx.beginPath();
        ctx.moveTo(640, centerY);
        ctx.lineTo(640 + xOffset, 720);
        ctx.stroke();
      }

      ctx.strokeStyle = '#312e81';
      ctx.lineWidth = 2;
      ctx.strokeRect(20, 20, 1240, 680);

      ctx.fillStyle = '#6366f1';
      ctx.fillRect(15, 15, 15, 3);
      ctx.fillRect(15, 15, 3, 15);
      ctx.fillRect(1250, 15, 15, 3);
      ctx.fillRect(1262, 15, 3, 15);

      particles.forEach((p) => {
        p.z -= 4;
        if (p.z <= 0) p.z = 1000;
        const k = 600 / p.z;
        const px = p.x * k + 640;
        const py = p.y * k + 360;

        if (px >= 20 && px <= 1260 && py >= 20 && py <= 700) {
          const size = (1 - p.z / 1000) * 6;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(px, py, size, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      const centerX = 640;
      const centerYObj = 320;
      const sizeObj = 120 + Math.sin(frame * 0.03) * 15;
      const angle = frame * 0.015;

      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.5;

      const vertices: { x: number; y: number }[] = [];
      for (let i = 0; i < 4; i++) {
        const theta = angle + (i * Math.PI) / 2;
        const x = sizeObj * Math.cos(theta);
        const y = (sizeObj / 3) * Math.sin(theta);
        vertices.push({ x: centerX + x, y: centerYObj + y });
      }

      const topPt = { x: centerX, y: centerYObj - sizeObj };
      const bottomPt = { x: centerX, y: centerYObj + sizeObj };

      for (let i = 0; i < 4; i++) {
        const p1 = vertices[i];
        const p2 = vertices[(i + 1) % 4];

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(topPt.x, topPt.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(bottomPt.x, bottomPt.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }

      ctx.fillStyle = '#6366f1';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('STREAMPEXEL STREAM PLAYER', 40, 50);

      ctx.fillStyle = '#a5b4fc';
      ctx.font = '10px monospace';
      ctx.fillText(`RESOLUTION: 1280x720 (720p)`, 40, 70);
      ctx.fillText(`STREAM TYPE: SIMULATED INSTANCE`, 40, 85);

      const fps = (60 + Math.sin(frame * 0.1) * 0.8).toFixed(1);
      const ping = (15 + Math.cos(frame * 0.05) * 1.5).toFixed(0);
      ctx.fillStyle = '#22d3ee';
      ctx.fillText(`FPS: ${fps}`, 1120, 50);
      ctx.fillText(`RTT: ${ping}ms`, 1120, 70);
      ctx.fillText(`BITRATE: 4.8 Mbps`, 1120, 90);

      ctx.fillStyle = frame % 30 < 15 ? '#ef4444' : '#7f1d1d';
      ctx.beginPath();
      ctx.arc(1200, 650, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('LIVE', 1215, 654);

      simIntervalRef.current = requestAnimationFrame(draw);
    };

    const video = document.createElement('video');
    video.className = 'w-full h-full object-contain';
    video.playsInline = true;
    video.muted = isMuted;
    video.autoplay = true;

    if (containerRef.current) {
      containerRef.current.appendChild(video);
    }

    const stream = canvas.captureStream(30);
    video.srcObject = stream;
    video.play().catch(() => {});

    simIntervalRef.current = requestAnimationFrame(draw);
  };

  const toggleMute = () => {
    const video = containerRef.current?.querySelector('video');
    if (video) {
      video.muted = !video.muted;
      setIsMuted(video.muted);
    }
  };

  const toggleFullscreen = () => {
    const video = containerRef.current?.querySelector('video');
    if (video) {
      if (video.requestFullscreen) {
        video.requestFullscreen();
      }
    }
  };

  if (error) {
    return (
      <div className="w-full aspect-video bg-slate-950 flex flex-col items-center justify-center p-6 text-center border border-red-500/20 rounded-2xl animate-in fade-in duration-200">
        <AlertCircle className="w-12 h-12 text-red-500 mb-3 animate-bounce" />
        <h4 className="text-white font-bold text-base">Failed to connect to stream</h4>
        <p className="text-xs text-slate-400 mt-1 max-w-sm">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 px-4.5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white rounded-xl transition-all shadow-lg shadow-indigo-600/20"
        >
          Retry Connection
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden border border-slate-900 flex items-center justify-center group shadow-2xl"
    >
      {loading && !connected && (
        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-3 z-10 animate-in fade-in duration-200">
          <RefreshCw className="w-10 h-10 text-indigo-500 animate-spin" />
          <div className="text-center">
            <p className="text-sm font-semibold text-white">Connecting WebRTC Stream...</p>
            <p className="text-xs text-slate-500 mt-1">Exchanging SDP configuration tokens</p>
          </div>
        </div>
      )}

      {connected && (
        <div className="absolute bottom-4 right-4 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-20">
          <button
            onClick={toggleMute}
            className="p-2.5 bg-black/60 hover:bg-black/80 text-white rounded-xl backdrop-blur-md transition-all border border-white/5"
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <button
            onClick={toggleFullscreen}
            className="p-2.5 bg-black/60 hover:bg-black/80 text-white rounded-xl backdrop-blur-md transition-all border border-white/5"
            title="Fullscreen"
          >
            <Maximize className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
