'use client';

import React, { useEffect, useState } from 'react';
import {
  Layers,
  Plus,
  Search,
  ExternalLink,
  Play,
  Square,
  Trash2,
  X,
  RefreshCw,
  AlertCircle,
  UploadCloud,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import api, { copyToClipboard } from '../../../services/api';

export default function ProjectsPage() {
  const router = useRouter();

  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search & Filter
  const [searchQuery, setSearchQuery] = useState('');

  // Upload Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [projName, setProjName] = useState('');
  const [projVersion, setProjVersion] = useState('UE 5.4');
  const [projFile, setProjFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects();
  }, []);

  const fetchProjects = async () => {
    try {
      setLoading(true);
      setError(null);
      const data: any = await api.get('/projects');
      setProjects(data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch projects list');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyShareLink = async (project: any) => {
    try {
      let slug = project.shareSlug;
      if (!slug) {
        const res: any = await api.post(`/projects/${project.id}/share-slug`);
        slug = res?.shareSlug || res?.data?.shareSlug;
        if (slug) {
          setProjects((prev) =>
            prev.map((p) => (p.id === project.id ? { ...p, shareSlug: slug } : p)),
          );
        }
      }
      if (!slug) {
        alert('Failed to generate share link.');
        return;
      }
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const shareUrl = `${origin}/watch/${slug}`;
      const copied = await copyToClipboard(shareUrl);
      if (copied) {
        alert(`Public share link copied to clipboard!\n\n${shareUrl}`);
      } else {
        alert(`Share link:\n${shareUrl}`);
      }
    } catch (err: any) {
      alert(`Failed to get share link: ${err.message || 'Unknown error'}`);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setProjFile(e.target.files[0]);
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projName || !projFile) {
      setUploadError('Please specify a project name and select a ZIP or RAR file.');
      return;
    }

    try {
      setUploading(true);
      setUploadError(null);
      setUploadProgress(0);

      const formData = new FormData();
      formData.append('file', projFile);
      formData.append('name', projName);
      formData.append('version', projVersion);

      await api.post('/projects/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        onUploadProgress: (progressEvent) => {
          const total = progressEvent.total || projFile.size;
          const current = progressEvent.loaded;
          const percent = Math.round((current * 100) / total);
          setUploadProgress(percent);
        },
      });

      // Reset Form & Close
      setProjName('');
      setProjFile(null);
      setIsModalOpen(false);
      fetchProjects();
    } catch (err: any) {
      setUploadError(err.message || 'Failed to upload project archive');
    } finally {
      setUploading(false);
    }
  };

  const startStream = async (id: string) => {
    try {
      // Optimistic update
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, status: 'RUNNING' } : p)));
      await api.post(`/projects/${id}/start`);
      // Redirect to streaming page
      router.push(`/dashboard/projects/${id}/stream`);
    } catch (err: any) {
      alert(`Error starting instance: ${err.message}`);
      fetchProjects();
    }
  };

  const stopStream = async (id: string) => {
    try {
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, status: 'STOPPED' } : p)));
      await api.post(`/projects/${id}/stop`);
      fetchProjects();
    } catch (err: any) {
      alert(`Error stopping instance: ${err.message}`);
      fetchProjects();
    }
  };

  const deleteProject = async (id: string) => {
    if (!confirm('Are you sure you want to delete this project and all its unzipped files?')) {
      return;
    }

    try {
      await api.delete(`/projects/${id}`);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err: any) {
      alert(`Error deleting project: ${err.message}`);
    }
  };

  const filteredProjects = projects.filter((project) =>
    project.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const activeInstances = projects.filter((p) => p.status === 'RUNNING').length;
  const activeViewers = projects.reduce((acc, p) => acc + (p.clients || 0), 0);

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Header Area */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
            Your Projects
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Upload and manage your Unreal Engine Pixel Streaming builds.
          </p>
        </div>
        <button
          onClick={() => setIsModalOpen(true)}
          className="glow-btn px-4.5 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl shadow-md shadow-indigo-600/25 transition-all flex items-center gap-2 self-start sm:self-auto"
        >
          <Plus className="w-4.5 h-4.5" />
          Upload Project
        </button>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <div className="glass-card p-6 rounded-2xl">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Total Projects
          </p>
          <p className="text-3xl font-extrabold text-white mt-2">{projects.length}</p>
        </div>
        <div className="glass-card p-6 rounded-2xl">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Active Instances
          </p>
          <p className="text-3xl font-extrabold text-indigo-400 mt-2">
            {activeInstances} <span className="text-xs text-slate-500 font-medium">/ 5 limit</span>
          </p>
        </div>
        <div className="glass-card p-6 rounded-2xl">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Active Viewers
          </p>
          <p className="text-3xl font-extrabold text-cyan-400 mt-2">{activeViewers}</p>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex items-center gap-4 bg-[#0C0E1C]/60 border border-slate-900 rounded-xl px-4 py-2.5 w-full max-w-md">
        <Search className="w-4.5 h-4.5 text-slate-500" />
        <input
          type="text"
          placeholder="Search projects..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none w-full"
        />
      </div>

      {/* Main projects view */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3 text-sm text-red-400">
          <AlertCircle className="w-5 h-5" />
          <p>{error}</p>
        </div>
      )}

      {loading && projects.length === 0 ? (
        <div className="text-center py-12">
          <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
          <p className="text-sm text-slate-500 mt-2">Loading projects...</p>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="glass-card rounded-2xl p-12 text-center border border-slate-900">
          <Layers className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-white">No projects found</h3>
          <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
            {searchQuery
              ? 'Adjust your search queries or upload a new Unreal Engine project.'
              : 'Get started by uploading your packaged Windows 64-bit Unreal Engine folder packaged inside a ZIP file.'}
          </p>
          {!searchQuery && (
            <button
              onClick={() => setIsModalOpen(true)}
              className="mt-6 px-4.5 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-all"
            >
              Upload Project
            </button>
          )}
        </div>
      ) : (
        /* Projects Table */
        <div className="glass-card rounded-2xl overflow-hidden border border-slate-900 shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-900 bg-slate-950/20 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <th className="p-4.5 pl-6">Project Name</th>
                  <th className="p-4.5">Engine Version</th>
                  <th className="p-4.5">Status</th>
                  <th className="p-4.5">Active Clients</th>
                  <th className="p-4.5">Uploaded</th>
                  <th className="p-4.5 pr-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/60 text-sm text-slate-300">
                {filteredProjects.map((project) => (
                  <tr key={project.id} className="hover:bg-white/[0.01] transition-colors">
                    <td className="p-4.5 pl-6 font-semibold text-white">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-slate-950/60 border border-white/5 flex items-center justify-center text-slate-400 shrink-0">
                          <Layers className="w-4.5 h-4.5" />
                        </div>
                        <div>
                          <span>{project.name}</span>
                          {project.status === 'RUNNING' && (
                            <button
                              onClick={() =>
                                router.push(`/dashboard/projects/${project.id}/stream`)
                              }
                              className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 mt-0.5"
                            >
                              Live Stream Player <ExternalLink className="w-2.5 h-2.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="p-4.5 font-medium text-slate-400">{project.version}</td>
                    <td className="p-4.5">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                          project.status === 'RUNNING'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-slate-500/10 text-slate-400'
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${project.status === 'RUNNING' ? 'bg-emerald-400' : 'bg-slate-400'}`}
                        />
                        {project.status}
                      </span>
                    </td>
                    <td className="p-4.5 font-medium">{project.clients || 0}</td>
                    <td className="p-4.5 text-slate-400 font-medium">
                      {new Date(project.createdAt).toLocaleDateString()}
                    </td>
                    <td className="p-4.5 pr-6 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {project.status === 'RUNNING' ? (
                          <>
                            <button
                              onClick={() =>
                                router.push(`/dashboard/projects/${project.id}/stream`)
                              }
                              className="px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 rounded-lg text-xs font-semibold transition-all"
                            >
                              View Stream
                            </button>
                            <button
                              onClick={() => stopStream(project.id)}
                              title="Stop Stream"
                              className="p-2 hover:bg-red-500/10 text-slate-400 hover:text-red-400 rounded-lg transition-all"
                            >
                              <Square className="w-4 h-4 fill-current" />
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => startStream(project.id)}
                            title="Start Stream"
                            className="p-2 hover:bg-emerald-500/10 text-slate-400 hover:text-emerald-400 rounded-lg transition-all"
                          >
                            <Play className="w-4 h-4 fill-current" />
                          </button>
                        )}
                        <button
                          onClick={() => handleCopyShareLink(project)}
                          title="Get Share Link"
                          className="p-2 hover:bg-indigo-500/10 text-slate-400 hover:text-indigo-400 rounded-lg transition-all"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => deleteProject(project.id)}
                          title="Delete Project"
                          className="p-2 hover:bg-red-500/10 text-slate-400 hover:text-red-400 rounded-lg transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Upload ZIP Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="glass-card w-full max-w-lg rounded-2xl overflow-hidden border border-white/10 shadow-2xl relative animate-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="p-5 border-b border-slate-900 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-white">
                  Upload UE Build Folder (.zip, .rar)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Package your build folder as a single ZIP or RAR archive to upload.
                </p>
              </div>
              <button
                onClick={() => !uploading && setIsModalOpen(false)}
                className="text-slate-400 hover:text-white p-1 hover:bg-white/5 rounded-lg transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleUploadSubmit} className="p-6 space-y-5">
              {uploadError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2.5 text-xs text-red-400">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <p>{uploadError}</p>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">Project Name</label>
                <input
                  type="text"
                  placeholder="e.g. My-Unreal-Project"
                  value={projName}
                  onChange={(e) => setProjName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                  required
                  disabled={uploading}
                  className="w-full bg-[#070913] border border-slate-900 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-600 transition-colors"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Unreal Engine Version
                </label>
                <select
                  value={projVersion}
                  onChange={(e) => setProjVersion(e.target.value)}
                  disabled={uploading}
                  className="w-full bg-[#070913] border border-slate-900 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-600 transition-colors"
                >
                  <option value="UE 5.4">Unreal Engine 5.4</option>
                  <option value="UE 5.3">Unreal Engine 5.3</option>
                  <option value="UE 5.2">Unreal Engine 5.2</option>
                  <option value="UE 5.1">Unreal Engine 5.1</option>
                  <option value="UE 5.0">Unreal Engine 5.0</option>
                  <option value="UE 4.27">Unreal Engine 4.27</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  ZIP or RAR Build Archive
                </label>
                <div className="border border-dashed border-slate-800 rounded-xl p-6 text-center bg-[#070913]/40 hover:border-indigo-500/30 transition-colors relative flex flex-col items-center justify-center">
                  <input
                    type="file"
                    accept=".zip,.rar"
                    onChange={handleFileChange}
                    required
                    disabled={uploading}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <UploadCloud className="w-10 h-10 text-slate-600 mb-2" />
                  <p className="text-xs font-semibold text-white">
                    {projFile ? projFile.name : 'Click or drag ZIP or RAR file here to upload'}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-1">
                    {projFile
                      ? `Size: ${(projFile.size / 1024 / 1024).toFixed(1)} MB`
                      : 'Must contain compiled binaries (e.g. executable and project content)'}
                  </p>
                </div>
              </div>

              {uploading && (
                <div className="space-y-1.5 pt-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-indigo-400">
                    <span>Uploading build archive...</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <div className="w-full bg-[#070913] h-2 rounded-full overflow-hidden border border-slate-900">
                    <div
                      className="bg-gradient-to-r from-indigo-500 to-cyan-400 h-full transition-all duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-900 mt-6">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={uploading}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uploading || !projName || !projFile}
                  className="px-4.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md transition-all flex items-center gap-1.5"
                >
                  {uploading ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    'Upload and Extract'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
