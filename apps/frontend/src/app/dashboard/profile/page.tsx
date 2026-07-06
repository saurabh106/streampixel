'use client';

import React from 'react';
import { useAuth } from '../../../hooks/useAuth';
import { Mail, Shield, Calendar } from 'lucide-react';

export default function ProfilePage() {
  const { user } = useAuth();

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">Your Profile</h1>
        <p className="text-sm text-slate-400 mt-1">
          Manage your account identity details and security configurations.
        </p>
      </div>

      <div className="glass-card rounded-2xl p-6 md:p-8 max-w-2xl space-y-6">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center text-2xl font-bold text-indigo-400">
            {user?.name ? user.name[0].toUpperCase() : 'U'}
          </div>
          <div>
            <h3 className="text-xl font-bold text-white">{user?.name || 'User Name'}</h3>
            <p className="text-sm text-slate-400 mt-0.5">{user?.role || 'USER'} Account</p>
          </div>
        </div>

        <div className="border-t border-slate-900 pt-6 space-y-4">
          <div className="flex items-center gap-3">
            <Mail className="w-4.5 h-4.5 text-slate-500" />
            <div>
              <p className="text-[10px] text-slate-500 font-bold uppercase">Email Address</p>
              <p className="text-sm font-semibold text-white mt-0.5">{user?.email || 'N/A'}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Shield className="w-4.5 h-4.5 text-slate-500" />
            <div>
              <p className="text-[10px] text-slate-500 font-bold uppercase">Role Authority</p>
              <p className="text-sm font-semibold text-white mt-0.5">{user?.role || 'N/A'}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Calendar className="w-4.5 h-4.5 text-slate-500" />
            <div>
              <p className="text-[10px] text-slate-500 font-bold uppercase">Registered On</p>
              <p className="text-sm font-semibold text-white mt-0.5">
                {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
