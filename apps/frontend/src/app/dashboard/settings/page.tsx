'use client';

import React from 'react';
import { Settings, Shield, Key } from 'lucide-react';

export default function SettingsPage() {
  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
          Platform Settings
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Configure your organization settings, API credentials, and developer options.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Navigation panel */}
        <div className="space-y-1">
          <button className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-sm font-semibold bg-indigo-600 text-white shadow-md shadow-indigo-600/15 text-left">
            <Settings className="w-4 h-4" />
            General Options
          </button>
          <button className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-white/5 text-left">
            <Key className="w-4 h-4" />
            API Keys & Access
          </button>
          <button className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-white/5 text-left">
            <Shield className="w-4 h-4" />
            IP Whitelists
          </button>
        </div>

        {/* Configurations Form */}
        <div className="md:col-span-2 glass-card rounded-2xl p-6 md:p-8 space-y-6">
          <h3 className="text-lg font-bold text-white">General Settings</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Organization Name
              </label>
              <input
                type="text"
                defaultValue="My Streaming Org"
                className="w-full bg-slate-950/50 border border-white/10 focus:border-indigo-500 rounded-xl py-3 px-4 text-sm text-white focus:outline-none transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Default Region Selection
              </label>
              <select className="w-full bg-slate-950/60 border border-white/10 focus:border-indigo-500 rounded-xl py-3 px-4 text-sm text-white focus:outline-none transition-all">
                <option value="us-east">US East (N. Virginia)</option>
                <option value="eu-west">EU West (Ireland)</option>
                <option value="ap-east">Asia Pacific (Tokyo)</option>
              </select>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <input
                type="checkbox"
                id="auto-scale"
                defaultChecked
                className="w-4 h-4 rounded border-white/10 bg-slate-950/50 text-indigo-600 focus:ring-indigo-500"
              />
              <label
                htmlFor="auto-scale"
                className="text-sm text-slate-300 font-medium cursor-pointer"
              >
                Automatically tear down inactive streams after 15 minutes of idle.
              </label>
            </div>
          </div>

          <div className="border-t border-slate-900 pt-6 flex justify-end">
            <button className="glow-btn px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold text-white rounded-xl shadow-md shadow-indigo-600/25 transition-all">
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
