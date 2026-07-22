'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Play,
  Square,
  AlertCircle,
  RefreshCw,
  Activity,
  Info,
  Link as LinkIcon,
} from 'lucide-react';
import api, { copyToClipboard } from '../../../../../services/api';
import PixelStreamPlayer from '../../../../../components/PixelStreamPlayer';

export default function StreamPlayerPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();

  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [isSimulated, setIsSimulated] = useState(false);
  const [instancePort, setInstancePort] = useState<number | null>(null);
  const [copiedShare, setCopiedShare] = useState(false);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 19)]);
  };

  useEffect(() => {
    fetchProjectDetails();
  }, [id]);

  const fetchProjectDetails = async () => {
    try {
      setLoading(true);
      setError(null);
      const data: any = await api.get(`/projects/${id}`);
      setProject(data);

      if (data.status === 'RUNNING') {
        const activeInstance = data.instances?.find((i: any) => i.status === 'RUNNING');
        if (activeInstance) {
          setInstancePort(activeInstance.port);
          setIsSimulated(activeInstance.pid === 9999);
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

  const copyShareLink = async () => {
    if (!project) return;
    try {
      let slug = project.shareSlug;
      if (!slug) {
        const res: any = await api.post(`/projects/${project.id}/share-slug`);
        slug = res?.shareSlug || res?.data?.shareSlug;
        if (slug) {
          setProject((prev: any) => ({ ...prev, shareSlug: slug }));
        }
      }
      if (!slug) return;
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const shareUrl = `${origin}/watch/${slug}`;
      const copied = await copyToClipboard(shareUrl);
      if (copied) {
        setCopiedShare(true);
        setTimeout(() => setCopiedShare(false), 2000);
      } else {
        alert(`Share link:\n${shareUrl}`);
      }
    } catch (err: any) {
      alert(`Error getting share link: ${err.message || 'Unknown error'}`);
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
            <h1 className="text-xl md:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              {project?.name || 'Project Stream'}
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Engine Version: {project?.version} · Status: {project?.status}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={copyShareLink}
            className={`px-4 py-2 text-xs font-semibold rounded-xl border transition-all flex items-center gap-1.5 ${
              copiedShare
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                : 'bg-white/5 border-white/10 hover:border-white/20 text-slate-300 hover:text-white'
            }`}
          >
            <LinkIcon className="w-3.5 h-3.5" />
            {copiedShare ? 'Copied URL!' : 'Get Share Link'}
          </button>

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
          {project?.status === 'RUNNING' && instancePort ? (
            <PixelStreamPlayer port={instancePort} isSimulated={isSimulated} onLog={addLog} />
          ) : (
            <div className="relative aspect-video bg-black rounded-2xl overflow-hidden border border-slate-900 flex items-center justify-center shadow-2xl">
              <div className="text-center p-6 space-y-4 max-w-sm">
                <Play className="w-12 h-12 text-slate-600 mx-auto" />
                <div>
                  <p className="text-sm font-semibold text-white">Stream is Offline</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Start the Unreal Engine project instance using the button above to begin
                    streaming.
                  </p>
                </div>
                <button
                  onClick={startInstance}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white rounded-xl transition-all"
                >
                  Start Stream
                </button>
              </div>
            </div>
          )}

          {/* Interactive tips */}
          <div className="glass-card p-5 rounded-2xl border border-slate-900">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Info className="w-4.5 h-4.5 text-indigo-400" />
              Epic Games Pixel Streaming Setup
            </h3>
            <ul className="text-xs text-slate-400 space-y-2 mt-3 list-disc pl-4">
              <li>
                This stream connects via Epic Games' official signaling server (Wilbur) spawned on a
                project-dedicated port on the backend.
              </li>
              <li>
                WebRTC rendering, data transmission, and input forwarding is handled by the official{' '}
                <code>@epicgames-ps/lib-pixelstreamingfrontend-ue5.5</code> npm package.
              </li>
              <li>
                If you choose <strong>Get Share Link</strong>, any public viewer can access your
                stream without logging in. Instances remain running until you explicitly stop them
                from the dashboard.
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
                    project?.status === 'RUNNING'
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : 'bg-slate-500/10 text-slate-400'
                  }`}
                >
                  {project?.status || 'OFFLINE'}
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
                <span className="text-xs text-white">Epic WebRTC</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400">Max Allowed CCU</span>
                <span className="text-xs text-cyan-400 font-semibold">
                  {project?.maxCCU || 3} players
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
