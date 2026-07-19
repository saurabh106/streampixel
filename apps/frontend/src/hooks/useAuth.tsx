'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import api, { setAccessToken } from '../services/api';
import { useRouter } from 'next/navigation';

interface UserDto {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: string;
  updatedAt: string;
}

interface AuthContextType {
  user: UserDto | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const refreshUser = async () => {
    try {
      const res: any = await api.get('/auth/me');
      setUser(res);
    } catch (e) {
      setUser(null);
    }
  };

  const checkAuth = async () => {
    try {
      const res: any = await api.post('/auth/refresh');
      setAccessToken(res.accessToken);
      setUser(res.user);
    } catch (e) {
      setAccessToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  const login = async (email: string, password: string) => {
    setLoading(true);
    try {
      const res: any = await api.post('/auth/login', { email, password });
      setAccessToken(res.accessToken);
      setUser(res.user);
      router.push('/dashboard');
    } catch (e) {
      setAccessToken(null);
      setUser(null);
      throw e;
    } finally {
      setLoading(false);
    }
  };

  const register = async (email: string, password: string, name?: string) => {
    setLoading(true);
    try {
      await api.post('/auth/register', { email, password, name });
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    setLoading(true);
    try {
      await api.post('/auth/logout');
    } catch (e) {
      console.error('Logout error', e);
    } finally {
      setAccessToken(null);
      setUser(null);
      setLoading(false);
      router.push('/login');
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        register,
        logout,
        isAuthenticated: !!user,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
