'use client';

import React from 'react';
import { Rocket, Globe } from 'lucide-react';

const mockDeployments = [
  {
    id: 'dep-1',
    project: 'ArchViz-Luxury-Villa',
    region: 'us-east-1 (N. Virginia)',
    status: 'Active',
    gpu: 'NVIDIA RTX 4090',
    launched: '2026-07-02 14:32',
  },
  {
    id: 'dep-2',
    project: 'Virtual-Showroom-Meta',
    region: 'eu-west-1 (Ireland)',
    status: 'Active',
    gpu: 'NVIDIA A10G',
    launched: '2026-07-04 09:15',
  },
];

export default function DeploymentsPage() {
  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">Deployments</h1>
        <p className="text-sm text-slate-400 mt-1">
          Monitor active deployments and scale instances across regional clusters.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="glass-card p-6 rounded-2xl flex items-start gap-4">
          <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl">
            <Globe className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Global Edge Nodes</h3>
            <p className="text-sm text-slate-400 mt-1">
              Stream to users from the closest edge node. Phase 2 orchestration will deploy
              pipelines closer to client requests.
            </p>
          </div>
        </div>

        <div className="glass-card p-6 rounded-2xl flex items-start gap-4">
          <div className="p-3 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 rounded-xl">
            <Rocket className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Active Deployment Clusters</h3>
            <p className="text-sm text-slate-400 mt-1">
              2 region nodes are currently online and accepting WebRTC viewer connections.
            </p>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-2xl overflow-hidden border border-slate-900">
        <div className="p-5 border-b border-slate-900 bg-slate-950/20">
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
            Active Deployments
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-900 bg-slate-950/10 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                <th className="p-4.5 pl-6">Deployment ID</th>
                <th className="p-4.5">Project</th>
                <th className="p-4.5">Region</th>
                <th className="p-4.5">GPU Tier</th>
                <th className="p-4.5">Launched At</th>
                <th className="p-4.5 pr-6">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-900/60 text-sm text-slate-300">
              {mockDeployments.map((dep) => (
                <tr key={dep.id} className="hover:bg-white/[0.01] transition-colors">
                  <td className="p-4.5 pl-6 font-mono text-xs text-slate-400">{dep.id}</td>
                  <td className="p-4.5 font-semibold text-white">{dep.project}</td>
                  <td className="p-4.5 flex items-center gap-1.5 mt-1.5">
                    <Globe className="w-3.5 h-3.5 text-slate-500" /> {dep.region}
                  </td>
                  <td className="p-4.5 font-medium">{dep.gpu}</td>
                  <td className="p-4.5 text-slate-400 font-medium">{dep.launched}</td>
                  <td className="p-4.5 pr-6">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      {dep.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
