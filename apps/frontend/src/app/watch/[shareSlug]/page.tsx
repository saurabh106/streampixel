'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import axios from 'axios';
import PixelStreamPlayer, {
  preloadPixelStreamingLibrary,
} from '../../../components/PixelStreamPlayer';

export default function PublicWatchPage() {
  const { shareSlug } = useParams() as { shareSlug: string };

  const [project, setProject] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSimulated, setIsSimulated] = useState(false);
  const [instancePort, setInstancePort] = useState<number | null>(null);
  const [streamActive, setStreamActive] = useState(false);

  useEffect(() => {
    // Kick off the PixelStreaming library import immediately — in parallel with
    // the API call below. By the time the API response arrives and the player
    // mounts, the library will already be loaded, saving ~0.5-2s of sequential
    // wait time.
    preloadPixelStreamingLibrary();

    if (shareSlug) {
      fetchSharedProject();
    }
  }, [shareSlug]);

  const fetchSharedProject = async (retryCount = 0) => {
    try {
      setError(null);

      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1';
      const res = await axios.get(`${API_URL}/public/projects/share/${shareSlug}`, {
        timeout: 30000,
      });

      const data = res.data.success ? res.data.data : res.data;
      setProject(data);
      setInstancePort(data.port);
      setIsSimulated(data.isSimulated);
      setStreamActive(true);
    } catch (err: any) {
      const errMsg =
        err.response?.data?.error?.message || err.message || 'Failed to connect to stream';

      if (retryCount < 3) {
        setTimeout(() => fetchSharedProject(retryCount + 1), 2000);
      } else {
        setError(errMsg);
      }
    }
  };

  if (error) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={() => {
              setError(null);
              fetchSharedProject();
            }}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white rounded-xl transition-all"
          >
            Retry
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
