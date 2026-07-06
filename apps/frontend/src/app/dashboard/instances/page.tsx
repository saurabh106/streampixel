'use client';

import React from 'react';

const mockInstances = [
  {
    id: 'inst-101',
    project: 'ArchViz-Luxury-Villa',
    region: 'us-east-1',
    port: '8081',
    status: 'Running',
    clients: 1,
    ram: '4.2GB / 16GB',
    cpu: '18%',
    gpuLoad: '42%',
  },
  {
    id: 'inst-102',
    project: 'ArchViz-Luxury-Villa',
    region: 'us-east-1',
    port: '8082',
    status: 'Running',
    clients: 2,
    ram: '4.8GB / 16GB',
    cpu: '22%',
    gpuLoad: '51%',
  },
  {
    id: 'inst-201',
    project: 'Virtual-Showroom-Meta',
    region: 'eu-west-1',
    port: '8081',
    status: 'Running',
    clients: 12,
    ram: '7.1GB / 16GB',
    cpu: '48%',
    gpuLoad: '89%',
  },
];

export default function InstancesPage() {
  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
          Active Instances
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Track and manage running container instances and virtual machine sessions.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
        {mockInstances.map((inst) => (
          <div
            key={inst.id}
            className="glass-card p-6 rounded-2xl space-y-4 hover:border-indigo-500/20 transition-all"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-slate-500 font-semibold">{inst.id}</span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400">
                {inst.status}
              </span>
            </div>
            <div>
              <h3 className="text-base font-bold text-white truncate">{inst.project}</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Region: {inst.region} · Port: {inst.port}
              </p>
            </div>

            <div className="border-t border-slate-900/60 pt-3.5 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase">Clients</p>
                <p className="text-sm font-semibold text-indigo-400 mt-0.5">{inst.clients}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase">CPU</p>
                <p className="text-sm font-semibold text-cyan-400 mt-0.5">{inst.cpu}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase">GPU</p>
                <p className="text-sm font-semibold text-violet-400 mt-0.5">{inst.gpuLoad}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
