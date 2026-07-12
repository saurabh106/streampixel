'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Play, AlertCircle, RefreshCw, Activity, Info, Tv } from 'lucide-react';
import axios from 'axios';
import PixelStreamPlayer from '../../../components/PixelStreamPlayer';

export default function PublicWatchPage() {
  const { shareSlug } = useParams() as { shareSlug: string };

  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [isSimulated, setIsSimulated] = useState(false);
  const [instancePort, setInstancePort] = useState<number | null>(null);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 19)]);
  };

  useEffect(() => {
    if (shareSlug) {
      fetchSharedProject();
    }
  }, [shareSlug]);

  const fetchSharedProject = async () => {
    try {
      setLoading(true);
      setError(null);
      addLog('Fetching shared project configuration...');

      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1';
      const res = await axios.get(`${API_URL}/public/projects/share/${shareSlug}`);

      const data = res.data.success ? res.data.data : res.data;
      setProject(data);
      setInstancePort(data.port);
      setIsSimulated(data.isSimulated);

      addLog(`Connected to instance port: ${data.port}`);
    } catch (err: any) {
      const errMsg =
        err.response?.data?.error?.message || err.message || 'Failed to connect to stream';
      setError(errMsg);
      addLog(`Error: ${errMsg}`);
    } finally {
      setLoading(false);
    }
  };

  if (loading && !project) {
    return (
      <div className="min-h-screen bg-[#070913] flex items-center justify-center">
        <div className="text-center space-y-3">
          <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
          <p className="text-sm text-slate-400">Negotiating active streaming lease...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#070913] text-[#F1F5F9] p-6 flex flex-col justify-between select-none">
      {/* Top Header */}
      <header className="max-w-6xl w-full mx-auto flex items-center justify-between pb-4 border-b border-slate-900">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 to-cyan-400 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
            S
          </div>
          <div>
            <h1 className="text-lg md:text-xl font-bold text-white tracking-tight">
              {project?.name || 'Shared Stream'}
            </h1>
            <p className="text-[10px] text-slate-400">Powered by Streampixel Edge Streaming Node</p>
          </div>
        </div>
        <div className="text-xs text-slate-500 flex items-center gap-2">
          <Tv className="w-4 h-4 text-indigo-500 animate-pulse" />
          <span>Public Viewer Mode</span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto py-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Stream player */}
        <div className="lg:col-span-2 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3 text-sm text-red-400">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          {project && instancePort ? (
            <PixelStreamPlayer port={instancePort} isSimulated={isSimulated} onLog={addLog} />
          ) : (
            <div className="relative aspect-video bg-black rounded-2xl overflow-hidden border border-slate-900 flex items-center justify-center shadow-2xl">
              <div className="text-center p-6 space-y-4 max-w-sm">
                <Play className="w-12 h-12 text-slate-600 mx-auto" />
                <div>
                  <p className="text-sm font-semibold text-white">Stream is Offline</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Please refresh the page to request a new stream connection slot.
                  </p>
                </div>
                <button
                  onClick={fetchSharedProject}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white rounded-xl transition-all"
                >
                  Request Connection
                </button>
              </div>
            </div>
          )}

          {/* Interactive tips */}
          <div className="glass-card p-5 rounded-2xl border border-slate-900">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Info className="w-4.5 h-4.5 text-indigo-400" />
              About Pixel Streaming
            </h3>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              This interactive application is streaming in real-time from a cloud-hosted GPU node.
              Inputs like mouse clicks, movement, and keypresses are sent directly to the server
              with sub-100ms latency.
            </p>
            <p className="text-[10px] text-indigo-400 font-semibold mt-2.5">
              Note: This instance will automatically stop after 60 seconds if no players are active
              to conserve GPU resources.
            </p>
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
                <span className="text-xs text-slate-400">Stream Host</span>
                <span className="text-xs text-white">127.0.0.1</span>
              </div>

              <div className="flex items-center justify-between border-b border-slate-900/60 pb-2">
                <span className="text-xs text-slate-400">Signaling Server Port</span>
                <span className="font-mono text-xs text-indigo-400 font-semibold">
                  {instancePort || 'N/A'}
                </span>
              </div>

              <div className="flex items-center justify-between border-b border-slate-900/60 pb-2">
                <span className="text-xs text-slate-400">Session Mode</span>
                <span className="text-xs text-white">
                  {isSimulated ? 'Simulated Preview' : 'Interactive GPU Stream'}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400">WebRTC Client</span>
                <span className="text-xs text-emerald-400 font-semibold">EpicGames SDK 5.5</span>
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
      </main>

      {/* Footer */}
      <footer className="max-w-6xl w-full mx-auto pt-6 border-t border-slate-900 flex flex-col md:flex-row items-center justify-between text-slate-500 text-xs gap-4">
        <span>© {new Date().getFullYear()} Streampixel. All rights reserved.</span>
        <div className="flex gap-6">
          <a href="/" className="hover:text-slate-300 transition-colors">
            Streampixel Platform Home
          </a>
        </div>
      </footer>
    </div>
  );
}
