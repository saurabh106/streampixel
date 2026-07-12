'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw, AlertCircle } from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';
import PixelStreamPlayer, {
  preloadPixelStreamingLibrary,
} from '../../../components/PixelStreamPlayer';

function generateViewerId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function getOrCreateViewerId(shareSlug: string): string {
  if (typeof window === 'undefined') return '';
  const key = `viewerId:${shareSlug}`;
  let id = localStorage.getItem(key);
  if (!id) {
    id = generateViewerId();
    localStorage.setItem(key, id);
  }
  return id;
}

export default function PublicWatchPage() {
  const { shareSlug } = useParams() as { shareSlug: string };

  const [error, setError] = useState<string | null>(null);
  const [isSimulated, setIsSimulated] = useState(false);
  const [instancePort, setInstancePort] = useState<number | null>(null);
  const [streamActive, setStreamActive] = useState(false);
  const viewerIdRef = useRef<string>('');

  useEffect(() => {
    // Kick off the PixelStreaming library import immediately — in parallel with
    // the API call below. By the time the API response arrives and the player
    // mounts, the library will already be loaded, saving ~0.5-2s of sequential
    // wait time.
    preloadPixelStreamingLibrary();

    if (shareSlug) {
      viewerIdRef.current = getOrCreateViewerId(shareSlug);
      fetchSharedProject();
    }

    // Cleanup: when the viewer closes their tab, stop only their instance
    return () => {
      if (shareSlug && viewerIdRef.current) {
        const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1';
        // Use sendBeacon for reliable delivery during page unload
        const blob = new Blob([JSON.stringify({ viewerId: viewerIdRef.current })], {
          type: 'application/json',
        });
        navigator.sendBeacon(`${API_URL}/public/projects/share/${shareSlug}/stop`, blob);
      }
    };
  }, [shareSlug]);

  const fetchSharedProject = async (retryCount = 0) => {
    try {
      setError(null);

      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1';

      // Detect the browser's exact viewport dimensions
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const res = await axios.post(
        `${API_URL}/public/projects/share/${shareSlug}`,
        {
          viewerId: viewerIdRef.current,
          viewportWidth,
          viewportHeight,
        },
        { timeout: 30000 },
      );

      const data = res.data.success ? res.data.data : res.data;
      setInstancePort(data.port);
      setIsSimulated(data.isSimulated);
      setStreamActive(true);
    } catch (err: any) {
      const errMsg =
        err.response?.data?.error?.message || err.message || 'Failed to connect to stream';

      if (retryCount < 3) {
        toast.loading(`Connecting... (attempt ${retryCount + 2}/4)`, {
          id: 'stream-connect',
          duration: 2000,
        });
        setTimeout(() => fetchSharedProject(retryCount + 1), 2000);
      } else {
        setError(errMsg);
        toast.error('Stream unavailable', {
          id: 'stream-connect',
          description: errMsg,
          duration: 8000,
        });
      }
    }
  };

  if (error) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center">
        <div className="text-center space-y-4 max-w-md px-6">
          <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto">
            <AlertCircle className="w-6 h-6 text-red-400" />
          </div>
          <h2 className="text-lg font-semibold text-white">Stream Unavailable</h2>
          <p className="text-sm text-slate-400 leading-relaxed">{error}</p>
          <button
            onClick={() => {
              setError(null);
              fetchSharedProject();
            }}
            className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white rounded-xl transition-all"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  if (!streamActive || !instancePort) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center">
        <div className="text-center space-y-3">
          <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
          <p className="text-xs text-slate-500">Connecting to stream...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-black overflow-hidden">
      <PixelStreamPlayer port={instancePort} isSimulated={isSimulated} fullscreen />
    </div>
  );
}
