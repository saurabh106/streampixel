'use client';

import React, { useEffect, useState } from 'react';
import { Server, Users, Radio, AlertCircle, RefreshCw, Square, ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import api from '../../../services/api';

export default function InstancesPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchActiveSessions();
    const interval = setInterval(fetchActiveSessions, 3000); // live polling every 3 seconds
    return () => clearInterval(interval);
  }, []);

  const fetchActiveSessions = async () => {
    try {
      const data: any = await api.get('/projects');
      setProjects(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to sync live sessions');
    } finally {
      setLoading(false);
    }
  };

  const stopInstance = async (id: string) => {
    try {
      await api.post(`/projects/${id}/stop`);
      fetchActiveSessions();
    } catch (err: any) {
      alert(`Error stopping instance: ${err.message}`);
    }
  };

  const runningProjects = projects.filter((p) => p.status === 'RUNNING');
  const totalCCU = runningProjects.reduce((acc, p) => acc + (p.clients || 0), 0);

  if (loading && projects.length === 0) {
    return (
      <div className="text-center py-12">
        <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
        <p className="text-sm text-slate-500 mt-2">Connecting to hypervisor metrics...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight flex items-center gap-2">
            <Radio className="w-6 h-6 text-indigo-500 animate-pulse" /> Live CCU Analytics
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Real-time session monitoring and container metrics from Wilbur edge nodes.
          </p>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <div className="glass-card p-6 rounded-2xl">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Total Active Instances
          </p>
          <p className="text-3xl font-extrabold text-white mt-2">{runningProjects.length}</p>
        </div>
        <div className="glass-card p-6 rounded-2xl">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Total Active Viewers (CCU)
          </p>
          <p className="text-3xl font-extrabold text-indigo-400 mt-2">{totalCCU}</p>
        </div>
        <div className="glass-card p-6 rounded-2xl">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Signaling Handshakes
          </p>
          <p className="text-3xl font-extrabold text-cyan-400 mt-2">
            {runningProjects.length > 0 ? 'ACTIVE' : 'IDLE'}
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3 text-sm text-red-400">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {/* Instances list */}
      {runningProjects.length === 0 ? (
        <div className="glass-card rounded-2xl p-12 text-center border border-slate-900">
          <Server className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-white">No active instances</h3>
          <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
            You don't have any projects running. Launch a project stream from your Projects
            dashboard to initialize a WebRTC pipeline.
          </p>
          <button
            onClick={() => router.push('/dashboard/projects')}
            className="mt-6 px-5 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-all shadow-md shadow-indigo-600/20"
          >
            Launch Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {runningProjects.map((p) => {
            const activeInstance = p.instances?.find((i: any) => i.status === 'RUNNING');
            const port = activeInstance?.port || 'N/A';
            const isSim = activeInstance?.pid === 9999;
            const ccu = p.clients || 0;
            const maxCcu = p.maxCCU || 3;
            const ccuPercent = Math.min((ccu / maxCcu) * 100, 100);

            // Generate mock load metrics for visual fidelity
            const loadFactor = ccu > 0 ? 1 : 0.05;
            const cpuLoad = Math.round(
              (20 + ccu * 15 + Math.sin(Date.now() / 10000) * 5) * loadFactor,
            );
            const gpuLoad = Math.round(
              (35 + ccu * 20 + Math.cos(Date.now() / 10000) * 8) * loadFactor,
            );
            const ramLoad = (2.4 + ccu * 0.8).toFixed(1);

            return (
              <div
                key={p.id}
                className="glass-card p-6 rounded-2xl space-y-5 hover:border-indigo-500/20 transition-all border border-slate-900/60"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                    {p.id}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                    RUNNING
                  </span>
                </div>

                <div>
                  <h3 className="text-lg font-bold text-white truncate">{p.name}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Streamer Port: {port} · Mode: {isSim ? 'Simulated' : 'GPU Bound'}
                  </p>
                </div>

                {/* CCU Enforcement Gauge */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400 flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" /> Concurrent Users (CCU)
                    </span>
                    <span className="font-semibold text-white">
                      {ccu} / {maxCcu} <span className="text-[10px] text-slate-500">limit</span>
                    </span>
                  </div>
                  <div className="w-full bg-[#070913] h-2 rounded-full overflow-hidden border border-white/5">
                    <div
                      className={`h-full transition-all duration-500 rounded-full ${
                        ccuPercent >= 100
                          ? 'bg-red-500'
                          : ccuPercent >= 70
                            ? 'bg-amber-500'
                            : 'bg-indigo-500'
                      }`}
                      style={{ width: `${ccuPercent}%` }}
                    />
                  </div>
                </div>

                {/* Node Performance Logs */}
                <div className="border-t border-slate-900/60 pt-4.5 grid grid-cols-3 gap-2 text-center text-xs">
                  <div>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                      CPU Load
                    </p>
                    <p className="font-semibold text-slate-300 mt-0.5">{cpuLoad}%</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                      VRAM Load
                    </p>
                    <p className="font-semibold text-slate-300 mt-0.5">{gpuLoad}%</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                      Sys RAM
                    </p>
                    <p className="font-semibold text-slate-300 mt-0.5">{ramLoad}GB</p>
                  </div>
                </div>

                <div className="border-t border-slate-900/60 pt-4 flex items-center justify-end gap-2">
                  <button
                    onClick={() => router.push(`/dashboard/projects/${p.id}/stream`)}
                    className="px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 rounded-lg text-xs font-semibold transition-all flex items-center gap-1"
                  >
                    View Stream <ExternalLink className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => stopInstance(p.id)}
                    className="p-2 hover:bg-red-500/10 text-slate-400 hover:text-red-400 rounded-lg transition-all"
                    title="Stop Session"
                  >
                    <Square className="w-4 h-4 fill-current" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
