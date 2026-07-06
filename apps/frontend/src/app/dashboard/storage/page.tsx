'use client';

import React from 'react';
import { HardDrive, FileArchive, Trash2 } from 'lucide-react';

const mockFiles = [
  {
    id: 'file-1',
    name: 'LuxuryVilla_UE5.4_Linux.zip',
    size: '4.8 GB',
    uploaded: '2026-06-15 11:22',
    downloads: 18,
  },
  {
    id: 'file-2',
    name: 'CyberCarConfig_UE5.3_Linux.zip',
    size: '3.2 GB',
    uploaded: '2026-06-20 09:41',
    downloads: 5,
  },
  {
    id: 'file-3',
    name: 'MetaShowroom_UE5.4_Linux.zip',
    size: '5.1 GB',
    uploaded: '2026-07-01 16:05',
    downloads: 32,
  },
];

export default function StoragePage() {
  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">Storage</h1>
        <p className="text-sm text-slate-400 mt-1">
          Manage your packaged game archives and assets assets.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="glass-card p-6 rounded-2xl md:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-white">Storage Capacity</h3>
            <span className="text-xs text-indigo-400 font-semibold">13.1 GB of 50 GB Used</span>
          </div>
          <div className="w-full h-2.5 bg-slate-900 rounded-full overflow-hidden border border-white/5">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 rounded-full"
              style={{ width: '26%' }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-3">
            Increase limits by upgrading to a business tier (Phase 3 billing integrations).
          </p>
        </div>

        <div className="glass-card p-6 rounded-2xl flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Total Archives
            </p>
            <p className="text-3xl font-extrabold text-white">3</p>
          </div>
          <div className="p-3.5 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl">
            <HardDrive className="w-6 h-6" />
          </div>
        </div>
      </div>

      <div className="glass-card rounded-2xl overflow-hidden border border-slate-900">
        <div className="p-5 border-b border-slate-900 bg-slate-950/20">
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
            Uploaded Archives
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-900 bg-slate-950/10 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                <th className="p-4.5 pl-6">Archive Name</th>
                <th className="p-4.5">File Size</th>
                <th className="p-4.5">Uploaded Date</th>
                <th className="p-4.5">Times Deployed</th>
                <th className="p-4.5 pr-6 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-900/60 text-sm text-slate-300">
              {mockFiles.map((file) => (
                <tr key={file.id} className="hover:bg-white/[0.01] transition-colors">
                  <td className="p-4.5 pl-6 font-semibold text-white">
                    <div className="flex items-center gap-2.5">
                      <FileArchive className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                      <span>{file.name}</span>
                    </div>
                  </td>
                  <td className="p-4.5 font-medium text-slate-400">{file.size}</td>
                  <td className="p-4.5 text-slate-400 font-medium">{file.uploaded}</td>
                  <td className="p-4.5 font-medium">{file.downloads}</td>
                  <td className="p-4.5 pr-6 text-right">
                    <button
                      className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                      title="Delete Archive"
                    >
                      <Trash2 className="w-4.5 h-4.5" />
                    </button>
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
