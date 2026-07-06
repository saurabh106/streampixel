import Link from 'next/link';
import { ArrowRight, Cpu, Zap, Globe, Code } from 'lucide-react';

export default function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden flex flex-col justify-between">
      {/* Background Decorative Blobs */}
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-indigo-600/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] rounded-full bg-cyan-500/10 blur-[130px] pointer-events-none" />

      {/* Navigation Header */}
      <header className="relative w-full max-w-7xl mx-auto px-6 py-5 flex items-center justify-between z-10">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-indigo-500 to-cyan-400 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
            S
          </div>
          <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
            Streampixel
          </span>
        </Link>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white transition-colors"
          >
            Sign In
          </Link>
          <Link
            href="/register"
            className="glow-btn px-4.5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg shadow-md shadow-indigo-600/20 transition-all flex items-center gap-1"
          >
            Get Started
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <main className="relative flex-1 max-w-5xl mx-auto px-6 flex flex-col items-center justify-center text-center py-20 z-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-xs font-semibold text-indigo-400 mb-8 animate-pulse">
          <Zap className="w-3.5 h-3.5" /> Introducing Streampixel Phase 1 Foundation
        </div>
        <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight text-white mb-6 leading-[1.15]">
          Unreal Engine Streaming{' '}
          <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
            Simplified.
          </span>
        </h1>
        <p className="text-lg md:text-xl text-slate-400 max-w-2xl mb-10 leading-relaxed">
          Upload your packaged Unreal Engine projects, deploy them to globally distributed GPU
          servers, and access interactive pixel streams instantly in any web browser.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link
            href="/register"
            className="glow-btn w-full sm:w-auto px-8 py-3.5 text-base font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl shadow-lg shadow-indigo-600/30 transition-all flex items-center justify-center gap-2"
          >
            Create Free Account
            <ArrowRight className="w-5 h-5" />
          </Link>
          <Link
            href="/login"
            className="w-full sm:w-auto px-8 py-3.5 text-base font-semibold text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-xl transition-all flex items-center justify-center"
          >
            Access Dashboard
          </Link>
        </div>

        {/* Feature Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 w-full mt-24">
          <div className="glass-card p-6 rounded-2xl text-left hover:border-indigo-500/30 transition-all group">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center mb-4 group-hover:bg-indigo-600 group-hover:text-white transition-all text-indigo-400">
              <Zap className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Sub-100ms Latency</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              Tailored WebRTC pipelines stream high-fidelity 3D graphics in real time with minimal
              latency.
            </p>
          </div>

          <div className="glass-card p-6 rounded-2xl text-left hover:border-cyan-500/30 transition-all group">
            <div className="w-10 h-10 rounded-xl bg-cyan-600/10 border border-cyan-500/20 flex items-center justify-center mb-4 group-hover:bg-cyan-600 group-hover:text-white transition-all text-cyan-400">
              <Cpu className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Automated Scaling</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              GPU nodes dynamically scale to meet traffic spikes, handling hundreds of concurrent
              players.
            </p>
          </div>

          <div className="glass-card p-6 rounded-2xl text-left hover:border-violet-500/30 transition-all group">
            <div className="w-10 h-10 rounded-xl bg-violet-600/10 border border-violet-500/20 flex items-center justify-center mb-4 group-hover:bg-violet-600 group-hover:text-white transition-all text-violet-400">
              <Globe className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Global Edge Nodes</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              Deploy your streams to nodes located around the globe to ensure your users get the
              closest server.
            </p>
          </div>

          <div className="glass-card p-6 rounded-2xl text-left hover:border-pink-500/30 transition-all group">
            <div className="w-10 h-10 rounded-xl bg-pink-600/10 border border-pink-500/20 flex items-center justify-center mb-4 group-hover:bg-pink-600 group-hover:text-white transition-all text-pink-400">
              <Code className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Custom SDK</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              Quickly embed and customize pixel streams on your website with our JavaScript SDK
              hooks.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative w-full max-w-7xl mx-auto px-6 py-8 border-t border-slate-900 flex flex-col md:flex-row items-center justify-between text-slate-500 text-xs gap-4 z-10">
        <span>© {new Date().getFullYear()} Streampixel. All rights reserved.</span>
        <div className="flex gap-6">
          <Link href="#" className="hover:text-slate-300 transition-colors">
            Terms of Service
          </Link>
          <Link href="#" className="hover:text-slate-300 transition-colors">
            Privacy Policy
          </Link>
          <Link href="/api/docs" className="hover:text-slate-300 transition-colors">
            API Docs
          </Link>
        </div>
      </footer>
    </div>
  );
}
