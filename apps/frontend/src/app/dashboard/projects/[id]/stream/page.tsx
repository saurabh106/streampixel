'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Play,
  Square,
  AlertCircle,
  RefreshCw,
  Maximize,
  Activity,
  Info,
} from 'lucide-react';
import api from '../../../../../services/api';

export default function StreamPlayerPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();

  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<string>('disconnected'); // disconnected, connecting, connected, failed
  const [logs, setLogs] = useState<string[]>([]);
  const [isSimulated, setIsSimulated] = useState(false);
  const [instancePort, setInstancePort] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 19)]);
  };

  useEffect(() => {
    fetchProjectDetails();
    return () => {
      disconnectStream();
    };
  }, [id]);

  const fetchProjectDetails = async () => {
    try {
      setLoading(true);
      setError(null);
      const data: any = await api.get(`/projects/${id}`);
      setProject(data);

      // If it is already running, we can start connecting
      if (data.status === 'RUNNING') {
        const activeInstance = data.instances?.find((i: any) => i.status === 'RUNNING');
        if (activeInstance) {
          setInstancePort(activeInstance.port);
          const isSim = activeInstance.pid === 9999;
          setIsSimulated(isSim);
          // Wait a second for state synchronization
          setTimeout(() => {
            if (isSim) {
              connectToSimulatedServer();
            } else {
              connectToSignalingServer(activeInstance.port);
            }
          }, 1000);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch project details');
      addLog(`Error: ${err.message || 'Failed to fetch project'}`);
    } finally {
      setLoading(false);
    }
  };

  const startInstance = async () => {
    try {
      setLoading(true);
      setError(null);
      addLog('Launching project instance on server...');

      const res: any = await api.post(`/projects/${id}/start`);
      addLog(res.message || 'Instance started successfully');
      setInstancePort(res.port);
      setIsSimulated(res.isSimulated);

      // Update local project status
      setProject((prev: any) => ({ ...prev, status: 'RUNNING' }));

      // Connect WebRTC after a short delay to allow signaling server to boot up
      addLog(`Connecting to signaling server on port ${res.port}...`);
      setTimeout(() => {
        if (res.isSimulated) {
          connectToSimulatedServer();
        } else {
          connectToSignalingServer(res.port);
        }
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to start project stream');
      addLog(`Launch Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const stopInstance = async () => {
    try {
      setLoading(true);
      disconnectStream();
      addLog('Stopping project instance...');

      await api.post(`/projects/${id}/stop`);
      addLog('Instance stopped.');
      setProject((prev: any) => ({ ...prev, status: 'STOPPED' }));
      setInstancePort(null);
    } catch (err: any) {
      setError(err.message || 'Failed to stop stream');
      addLog(`Stop Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const connectToSimulatedServer = () => {
    disconnectStream();
    setConnectionState('connecting');
    addLog('Establishing WebSocket to ws://localhost:8800/player (Simulation Mode)');

    // Simulate connection flow logs
    setTimeout(() => {
      addLog('WebSocket connection opened (Simulated)');
      addLog('Received WebRTC configuration from simulated server');
      addLog('Initializing RTCPeerConnection (Simulated)...');
    }, 500);

    setTimeout(() => {
      addLog('Received WebRTC SDP Offer from simulated Streamer');
      addLog('Set remote description (Offer) (Simulated)');
      addLog('Created local description (Answer) (Simulated)');
      addLog('Sent SDP Answer to simulated signaling server');
    }, 1000);

    setTimeout(() => {
      addLog('ICE Connection State: checking');
    }, 1500);

    setTimeout(() => {
      addLog('ICE Connection State: connected');
      setConnectionState('connected');
      addLog('WebRTC Audio/Video stream connected successfully! (Simulated)');

      // Start rendering simulated video using canvas
      setTimeout(() => {
        startSimulatedVideo();
      }, 100);
    }, 2000);
  };

  const startSimulatedVideo = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    let particles: { x: number; y: number; z: number; color: string }[] = [];
    for (let i = 0; i < 100; i++) {
      particles.push({
        x: (Math.random() - 0.5) * 1000,
        y: (Math.random() - 0.5) * 1000,
        z: Math.random() * 1000,
        color: `hsl(${200 + Math.random() * 60}, 80%, 70%)`,
      });
    }

    const draw = () => {
      if (!videoRef.current || !videoRef.current.srcObject) return;

      frame++;

      // Clear with dark gradient background
      ctx.fillStyle = '#0b0c16';
      ctx.fillRect(0, 0, 1280, 720);

      // Draw grid floor (retro-wave perspective)
      ctx.strokeStyle = '#1e1b4b';
      ctx.lineWidth = 1;
      const centerY = 450;
      const speed = 2;
      const offset = (frame * speed) % 40;

      // Horizontal lines
      for (let y = centerY; y < 720; y += 20) {
        const animatedY = y + (offset * (y - centerY)) / 270;
        ctx.beginPath();
        ctx.moveTo(0, animatedY);
        ctx.lineTo(1280, animatedY);
        ctx.stroke();
      }

      // Perspective vertical lines
      const lineCount = 30;
      for (let i = 0; i <= lineCount; i++) {
        const xProgress = i / lineCount;
        const xOffset = (xProgress - 0.5) * 2000;
        ctx.beginPath();
        ctx.moveTo(640, centerY);
        ctx.lineTo(640 + xOffset, 720);
        ctx.stroke();
      }

      // Draw HUD Borders
      ctx.strokeStyle = '#312e81';
      ctx.lineWidth = 2;
      ctx.strokeRect(20, 20, 1240, 680);

      // Corners crosshairs
      ctx.fillStyle = '#6366f1';
      ctx.fillRect(15, 15, 15, 3);
      ctx.fillRect(15, 15, 3, 15);
      ctx.fillRect(1250, 15, 15, 3);
      ctx.fillRect(1262, 15, 3, 15);
      ctx.fillRect(15, 698, 15, 3);
      ctx.fillRect(15, 686, 3, 15);
      ctx.fillRect(1250, 698, 15, 3);
      ctx.fillRect(1262, 686, 3, 15);

      // Draw animated starfield flying through
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

      // Rotating wireframe double-pyramid/diamond in center
      const centerX = 640;
      const centerYObj = 320;
      const sizeObj = 120 + Math.sin(frame * 0.03) * 15;
      const angle = frame * 0.015;

      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.5;

      // Projected 3D Vertices
      const vertices: { x: number; y: number }[] = [];
      const numPoints = 4;
      for (let i = 0; i < numPoints; i++) {
        const theta = angle + (i * Math.PI) / 2;
        const x = sizeObj * Math.cos(theta);
        const y = (sizeObj / 3) * Math.sin(theta);
        vertices.push({ x: centerX + x, y: centerYObj + y });
      }

      const topPt = { x: centerX, y: centerYObj - sizeObj };
      const bottomPt = { x: centerX, y: centerYObj + sizeObj };

      // Draw lines
      for (let i = 0; i < numPoints; i++) {
        const p1 = vertices[i];
        const p2 = vertices[(i + 1) % numPoints];

        // Mid belt
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();

        // Top to mid
        ctx.beginPath();
        ctx.moveTo(topPt.x, topPt.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();

        // Bottom to mid
        ctx.beginPath();
        ctx.moveTo(bottomPt.x, bottomPt.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }

      // Draw HUD Text
      ctx.fillStyle = '#6366f1';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('STREAMPEXEL STREAM PLAYER', 40, 50);

      ctx.fillStyle = '#a5b4fc';
      ctx.font = '10px monospace';
      ctx.fillText(`RESOLUTION: 1920x1080 (1080p)`, 40, 70);
      ctx.fillText(`STREAM TYPE: SIMULATED INSTANCE`, 40, 85);

      // Diagnostics stats on right
      const fps = (60 + Math.sin(frame * 0.1) * 0.8).toFixed(1);
      const ping = (15 + Math.cos(frame * 0.05) * 1.5).toFixed(0);
      ctx.fillStyle = '#22d3ee';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(`FPS: ${fps}`, 1120, 50);
      ctx.fillText(`RTT: ${ping}ms`, 1120, 70);
      ctx.fillText(`BITRATE: 4.8 Mbps`, 1120, 90);

      // Animated "LIVE" badge
      ctx.fillStyle = frame % 30 < 15 ? '#ef4444' : '#7f1d1d';
      ctx.beginPath();
      ctx.arc(1200, 650, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('LIVE', 1215, 654);

      requestAnimationFrame(draw);
    };

    // Create stream from canvas
    const stream = canvas.captureStream(30);
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => {});
    }

    // Run draw loop
    requestAnimationFrame(draw);
  };

  const connectToSignalingServer = (port: number) => {
    disconnectStream();
    setConnectionState('connecting');
    addLog(`Establishing WebSocket to ws://localhost:${port}/player`);

    const wsUrl = `ws://localhost:${port}/player`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      addLog('WebSocket connection opened');
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'config') {
          addLog('Received WebRTC configuration from server');
          initializePeerConnection(msg.peerConnectionOptions, ws);
        } else if (msg.type === 'offer') {
          addLog('Received WebRTC SDP Offer from Streamer');
          handleOffer(msg, ws);
        } else if (msg.type === 'answer') {
          addLog('Received WebRTC SDP Answer from Streamer');
          handleAnswer(msg);
        } else if (msg.type === 'iceCandidate') {
          addLog('Received remote ICE Candidate');
          handleIceCandidate(msg.candidate);
        } else if (msg.type === 'streamerDisconnected') {
          addLog('Warning: Unreal Engine Streamer disconnected');
          setConnectionState('connecting');
          if (videoRef.current) {
            videoRef.current.srcObject = null;
          }
        }
      } catch (err) {
        // Fallback for non-JSON or other messages
      }
    };

    ws.onerror = () => {
      addLog('WebSocket error encountered');
      setConnectionState('failed');
    };

    ws.onclose = () => {
      addLog('WebSocket connection closed');
      if (connectionState !== 'failed') {
        setConnectionState('disconnected');
      }
    };
  };

  const initializePeerConnection = (options: any, ws: WebSocket) => {
    addLog('Initializing RTCPeerConnection...');
    const pc = new RTCPeerConnection(
      options || {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
    );
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'iceCandidate',
            candidate: event.candidate,
          }),
        );
      }
    };

    pc.oniceconnectionstatechange = () => {
      addLog(`ICE Connection State: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'connected') {
        setConnectionState('connected');
        addLog('WebRTC Audio/Video stream connected successfully!');
      } else if (pc.iceConnectionState === 'failed') {
        setConnectionState('failed');
        addLog('WebRTC ICE negotiation failed');
      }
    };

    pc.ontrack = (event) => {
      addLog(`Received track: ${event.track.kind}`);
      if (videoRef.current && event.streams && event.streams[0]) {
        videoRef.current.srcObject = event.streams[0];
        videoRef.current.play().catch(() => {
          addLog('Autoplay prevented. Please click on the screen to unmute/play.');
        });
      }
    };

    // If we initiate the offer (some versions of Pixel Streaming)
    // createOffer(pc, ws);
  };

  const handleOffer = async (offer: any, ws: WebSocket) => {
    const pc = pcRef.current;
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      addLog('Set remote description (Offer)');

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      addLog('Created local description (Answer)');

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'answer',
            sdp: answer.sdp,
          }),
        );
        addLog('Sent SDP Answer to signaling server');
      }
    } catch (err: any) {
      addLog(`SDP Error: ${err.message}`);
    }
  };

  const handleAnswer = async (answer: any) => {
    const pc = pcRef.current;
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      addLog('Set remote description (Answer)');
    } catch (err: any) {
      addLog(`SDP Answer Error: ${err.message}`);
    }
  };

  const handleIceCandidate = async (candidate: any) => {
    const pc = pcRef.current;
    if (!pc) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err: any) {
      // ignore candidate error
    }
  };

  const disconnectStream = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setConnectionState('disconnected');
    addLog('Disconnected WebRTC stream');
  };

  const toggleFullscreen = () => {
    if (videoRef.current) {
      if (videoRef.current.requestFullscreen) {
        videoRef.current.requestFullscreen();
      }
    }
  };

  if (loading && !project) {
    return (
      <div className="min-h-screen bg-[#070913] flex items-center justify-center">
        <div className="text-center space-y-3">
          <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
          <p className="text-sm text-slate-400">Loading stream parameters...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto animate-in fade-in duration-300">
      {/* Header breadcrumb */}
      <div className="flex items-center justify-between border-b border-slate-900 pb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/dashboard/projects')}
            className="p-2 hover:bg-white/5 rounded-xl text-slate-400 hover:text-white transition-all"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-white tracking-tight">
              {project?.name || 'Project Stream'}
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Engine Version: {project?.version} · Status: {project?.status}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {project?.status === 'RUNNING' ? (
            <button
              onClick={stopInstance}
              className="px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 rounded-xl shadow-md transition-all flex items-center gap-1.5"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              Stop Instance
            </button>
          ) : (
            <button
              onClick={startInstance}
              className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl shadow-md transition-all flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              Start Instance
            </button>
          )}
        </div>
      </div>

      {/* Error Bar */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3 text-sm text-red-400">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {/* Main Grid: Stream Player + Status/Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Stream viewport */}
        <div className="lg:col-span-2 space-y-4">
          <div className="relative aspect-video bg-black rounded-2xl overflow-hidden border border-slate-900 flex items-center justify-center group shadow-2xl">
            {connectionState === 'connected' ? (
              <video
                ref={videoRef}
                className="w-full h-full object-contain"
                playsInline
                muted
                autoPlay
              />
            ) : (
              <div className="text-center p-6 space-y-4 max-w-sm z-10">
                {connectionState === 'connecting' ? (
                  <>
                    <RefreshCw className="w-10 h-10 text-indigo-500 animate-spin mx-auto" />
                    <div>
                      <p className="text-sm font-semibold text-white">
                        Negotiating WebRTC stream...
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        Exchanging SDP tokens and establishing direct media channel
                      </p>
                    </div>
                  </>
                ) : connectionState === 'failed' ? (
                  <>
                    <AlertCircle className="w-10 h-10 text-red-500 mx-auto" />
                    <div>
                      <p className="text-sm font-semibold text-white">WebRTC Connection Failed</p>
                      <p className="text-xs text-slate-400 mt-1">
                        Signaling server port was open, but WebRTC could not find a connection
                        route. Check local network bindings or enable STUN/TURN.
                      </p>
                    </div>
                    <button
                      onClick={() => instancePort && connectToSignalingServer(instancePort)}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white rounded-xl transition-all"
                    >
                      Retry Connection
                    </button>
                  </>
                ) : (
                  <>
                    <Play className="w-12 h-12 text-slate-600 mx-auto" />
                    <div>
                      <p className="text-sm font-semibold text-white">Stream is Offline</p>
                      <p className="text-xs text-slate-500 mt-1">
                        {project?.status === 'RUNNING'
                          ? 'Instance is active, but streaming connection is not established.'
                          : 'Start the Unreal Engine project instance using the button above to begin streaming.'}
                      </p>
                    </div>
                    {project?.status !== 'RUNNING' && (
                      <button
                        onClick={startInstance}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white rounded-xl transition-all"
                      >
                        Start Stream
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Simulated Overlay */}
            {project?.status === 'RUNNING' && isSimulated && (
              <div className="absolute top-4 left-4 bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider backdrop-blur-md">
                Simulated Instance (No local GPU)
              </div>
            )}

            {/* Video overlay controls */}
            {connectionState === 'connected' && (
              <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <button
                  onClick={toggleFullscreen}
                  className="p-2 bg-black/60 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm transition-all"
                  title="Fullscreen"
                >
                  <Maximize className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Interactive tips */}
          <div className="glass-card p-5 rounded-2xl border border-slate-900">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Info className="w-4.5 h-4.5 text-indigo-400" />
              How Pixel Streaming works in this MVP
            </h3>
            <ul className="text-xs text-slate-400 space-y-2 mt-3 list-disc pl-4">
              <li>
                When you click <strong>Start Instance</strong>, the backend allocates a dedicated
                port and runs a Node WebRTC Signaling Server.
              </li>
              <li>
                If the uploaded ZIP contains a Windows executable, the backend spawns the Unreal
                Engine application with Pixel Streaming enabled, automatically connecting it to the
                signaling server.
              </li>
              <li>
                Your browser establishes a peer WebSocket handshake to receive the SDP description
                and begins receiving video rendering over direct peer-to-peer WebRTC!
              </li>
              <li>
                <em>Simulation Mode:</em> If no Windows executable is detected, the backend starts
                the signaling port and simulates the state so you can see how the interface
                operates.
              </li>
            </ul>
          </div>
        </div>

        {/* Diagnostics & Connection Logs */}
        <div className="space-y-6">
          {/* Status Panel */}
          <div className="glass-card p-5 rounded-2xl border border-slate-900 space-y-4">
            <h3 className="text-sm font-bold text-white tracking-tight uppercase text-slate-400 text-xs">
              Diagnostics
            </h3>

            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-slate-900/60 pb-2">
                <span className="text-xs text-slate-400">Stream Status</span>
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                    connectionState === 'connected'
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : connectionState === 'connecting'
                        ? 'bg-amber-500/10 text-amber-400'
                        : 'bg-slate-500/10 text-slate-400'
                  }`}
                >
                  {connectionState.toUpperCase()}
                </span>
              </div>

              <div className="flex items-center justify-between border-b border-slate-900/60 pb-2">
                <span className="text-xs text-slate-400">Signaling Server Port</span>
                <span className="font-mono text-xs text-indigo-400 font-semibold">
                  {instancePort || 'N/A'}
                </span>
              </div>

              <div className="flex items-center justify-between border-b border-slate-900/60 pb-2">
                <span className="text-xs text-slate-400">P2P Protocol</span>
                <span className="text-xs text-white">WebRTC (RTCDataChannel)</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400">Streaming Mode</span>
                <span className="text-xs text-white">
                  {isSimulated ? 'Simulated (Idle)' : 'GPU Rendering'}
                </span>
              </div>
            </div>
          </div>

          {/* Logs Panel */}
          <div className="glass-card p-5 rounded-2xl border border-slate-900 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white tracking-tight uppercase text-slate-400 text-xs flex items-center gap-1.5">
                <Activity className="w-4 h-4 text-indigo-400" />
                Connection Logs
              </h3>
              <button
                onClick={() => setLogs([])}
                className="text-[10px] text-slate-500 hover:text-white uppercase font-bold"
              >
                Clear
              </button>
            </div>

            <div className="h-60 overflow-y-auto bg-slate-950/60 border border-slate-900/80 rounded-xl p-3 font-mono text-[10px] text-slate-400 space-y-1.5 select-text">
              {logs.length === 0 ? (
                <p className="text-slate-600 italic">No events logged yet.</p>
              ) : (
                logs.map((log, idx) => (
                  <p key={idx} className="leading-relaxed truncate" title={log}>
                    {log}
                  </p>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
