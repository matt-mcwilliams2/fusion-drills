import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import PlayerLogin from './pages/PlayerLogin';
import PlayerLayout from './pages/PlayerLayout';
import Today from './pages/Today';
import Leaderboard from './pages/Leaderboard';
import Me from './pages/Me';
import AdminLayout from './pages/AdminLayout';
import Roster from './pages/admin/Roster';
import Drills from './pages/admin/Drills';
import Seasons from './pages/admin/Seasons';
import AdminLeaderboard from './pages/admin/Leaderboard';
import InviteCoach from './pages/admin/InviteCoach';
import SuperAdmin from './pages/SuperAdmin';
import ClubAdmin from './pages/ClubAdmin';
import InviteAccept from './pages/InviteAccept';
import ConsentPage from './pages/ConsentPage';
import ParentPortalRequest from './pages/ParentPortalRequest';
import ParentPortal from './pages/ParentPortal';

function StaffRoute({ children, roles }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading"><div className="spinner" /></div>;
  if (!user) return <Navigate to="/login" />;
  if (roles && !roles.includes(user.role)) {
    if (user.role === 'player') return <Navigate to="/" />;
    if (user.role === 'coach') return <Navigate to="/admin" />;
    if (user.role === 'super_admin') return <Navigate to="/super" />;
    if (user.role === 'club_admin') return <Navigate to="/club" />;
    return <Navigate to="/login" />;
  }
  return children;
}

function PlayerRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading"><div className="spinner" /></div>;
  if (!user || user.role !== 'player') return null; // PlayerLogin handles unauthenticated
  return children;
}

function LoginRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading"><div className="spinner" /></div>;
  if (user) {
    if (user.role === 'coach') return <Navigate to="/admin" />;
    if (user.role === 'super_admin') return <Navigate to="/super" />;
    if (user.role === 'club_admin') return <Navigate to="/club" />;
    return <Navigate to="/" />;
  }
  return <Login />;
}

function TeamEntry() {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading"><div className="spinner" /></div>;
  if (!user || user.role !== 'player') return <PlayerLogin />;
  return <PlayerLayout />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRedirect />} />
      <Route path="/t/:joinCode/*" element={<TeamEntry />}>
        <Route index element={<PlayerRoute><Today /></PlayerRoute>} />
        <Route path="leaderboard" element={<PlayerRoute><Leaderboard /></PlayerRoute>} />
        <Route path="me" element={<PlayerRoute><Me /></PlayerRoute>} />
      </Route>
      <Route path="/admin" element={<StaffRoute roles={['coach', 'super_admin', 'club_admin']}><AdminLayout /></StaffRoute>}>
        <Route index element={<Roster />} />
        <Route path="drills" element={<Drills />} />
        <Route path="seasons" element={<Seasons />} />
        <Route path="leaderboard" element={<AdminLeaderboard />} />
        <Route path="invite" element={<InviteCoach />} />
      </Route>
      <Route path="/super" element={<StaffRoute roles={['super_admin']}><SuperAdmin /></StaffRoute>} />
      <Route path="/club" element={<StaffRoute roles={['club_admin']}><ClubAdmin /></StaffRoute>} />
      <Route path="/invite/:token" element={<InviteAccept />} />
      <Route path="/consent/:token" element={<ConsentPage />} />
      <Route path="/parent-portal" element={<ParentPortalRequest />} />
      <Route path="/parent-portal/:token" element={<ParentPortal />} />
      <Route path="*" element={<Navigate to="/login" />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
