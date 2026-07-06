'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../../hooks/useAuth';
import {
  Layers,
  Rocket,
  Server,
  HardDrive,
  Settings,
  User,
  LogOut,
  Menu,
  X,
  Bell,
  ChevronDown,
} from 'lucide-react';

const navItems = [
  { name: 'Projects', href: '/dashboard/projects', icon: Layers },
  { name: 'Deployments', href: '/dashboard/deployments', icon: Rocket },
  { name: 'Instances', href: '/dashboard/instances', icon: Server },
  { name: 'Storage', href: '/dashboard/storage', icon: HardDrive },
  { name: 'Settings', href: '/dashboard/settings', icon: Settings },
  { name: 'Profile', href: '/dashboard/profile', icon: User },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, logout, loading } = useAuth();
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#070913] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-slate-400">Loading session...</span>
        </div>
      </div>
    );
  }

  const currentTab = navItems.find((item) => pathname.startsWith(item.href))?.name || 'Dashboard';

  return (
    <div className="min-h-screen bg-[#070913] flex text-[#F1F5F9]">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex flex-col w-64 bg-[#0C0E1C] border-r border-slate-900 shrink-0">
        <div className="h-16 px-6 flex items-center gap-2 border-b border-slate-900">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-cyan-400 flex items-center justify-center font-bold text-white shadow-md shadow-indigo-500/10">
            S
          </div>
          <span className="font-bold tracking-tight text-white text-lg">Streampixel</span>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-1.5">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/15'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-900">
          <button
            onClick={logout}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-sm font-medium text-red-400 hover:bg-red-500/5 hover:text-red-300 transition-all text-left"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Sidebar - Mobile Menu */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 md:hidden flex">
          <aside className="w-64 bg-[#0C0E1C] h-full flex flex-col p-4 animate-in slide-in-from-left duration-200">
            <div className="flex items-center justify-between mb-8 pb-4 border-b border-slate-900">
              <span className="font-bold text-white">Streampixel</span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1">
              {navItems.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                      isActive
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.name}
                  </Link>
                );
              })}
            </nav>
            <button
              onClick={() => {
                setMobileMenuOpen(false);
                logout();
              }}
              className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-sm font-medium text-red-400 hover:bg-red-500/5 hover:text-red-300 transition-all text-left mt-auto border-t border-slate-900 pt-4"
            >
              <LogOut className="w-4 h-4" />
              Sign Out
            </button>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-h-screen overflow-x-hidden">
        {/* Top Header */}
        <header className="h-16 px-6 border-b border-slate-900 flex items-center justify-between bg-[#0C0E1C]/50 backdrop-blur-md sticky top-0 z-40">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="text-slate-400 hover:text-white md:hidden"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider hidden sm:block">
              {currentTab}
            </h2>
          </div>

          <div className="flex items-center gap-4">
            <button className="relative p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all">
              <Bell className="w-4 h-4" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-indigo-500" />
            </button>

            <div className="relative">
              <button
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className="flex items-center gap-2.5 p-1 px-2.5 rounded-xl hover:bg-white/5 transition-all text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-400">
                  {user?.name ? user.name[0].toUpperCase() : 'U'}
                </div>
                <div className="hidden sm:block">
                  <p className="text-xs font-medium text-white line-clamp-1">
                    {user?.name || 'User'}
                  </p>
                  <p className="text-[10px] text-slate-500 font-semibold uppercase">
                    {user?.role || 'User'}
                  </p>
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              </button>

              {dropdownOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
                  <div className="absolute right-0 mt-2 w-48 rounded-xl glass-card p-1.5 shadow-lg border border-white/10 z-50 animate-in fade-in slide-in-from-top-2 duration-100">
                    <div className="px-3.5 py-2 border-b border-white/5 mb-1.5">
                      <p className="text-xs text-slate-400">Signed in as</p>
                      <p className="text-xs font-semibold text-white truncate">{user?.email}</p>
                    </div>
                    <Link
                      href="/dashboard/profile"
                      onClick={() => setDropdownOpen(false)}
                      className="flex items-center gap-2.5 w-full px-3.5 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-white/5 rounded-lg transition-all"
                    >
                      <User className="w-3.5 h-3.5 text-slate-400" />
                      Your Profile
                    </Link>
                    <Link
                      href="/dashboard/settings"
                      onClick={() => setDropdownOpen(false)}
                      className="flex items-center gap-2.5 w-full px-3.5 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-white/5 rounded-lg transition-all"
                    >
                      <Settings className="w-3.5 h-3.5 text-slate-400" />
                      Settings
                    </Link>
                    <button
                      onClick={() => {
                        setDropdownOpen(false);
                        logout();
                      }}
                      className="flex items-center gap-2.5 w-full px-3.5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/5 hover:text-red-300 rounded-lg transition-all text-left mt-1.5 border-t border-white/5 pt-2"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      Sign Out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 p-6 md:p-8 max-w-7xl w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
