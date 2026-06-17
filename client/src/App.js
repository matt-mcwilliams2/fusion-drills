import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import PlayerLayout from './pages/PlayerLayout';
import Today from './pages/Today';
import Leaderboard from './pages/Leaderboard';
import Me from './pages/Me';
import AdminLayout from './pages/AdminLayout';
import Roster from './pages/admin/Roster';
import Drills from './pages/admin/Drills';
import Seasons from './pages/admin/Seasons';
import InviteCoach from './pages/admin/InviteCoach';

function ProtectedRoute({ children, role }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading"><div className="spinner" /></div>;
  if (!user) return <Navigate to="/login" />;
  if (role && user.role !== role) return <Navigate to={user.role === 'coach' ? '/admin' : '/'} />;
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) return <div className="loading"><div className="spinner" /></div>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={user.role === 'coach' ? '/admin' : '/'} /> : <Login />} />
      <Route path="/" element={<ProtectedRoute role="player"><PlayerLayout /></ProtectedRoute>}>
        <Route index element={<Today />} />
        <Route path="leaderboard" element={<Leaderboard />} />
        <Route path="me" element={<Me />} />
      </Route>
      <Route path="/admin" element={<ProtectedRoute role="coach"><AdminLayout /></ProtectedRoute>}>
        <Route index element={<Roster />} />
        <Route path="drills" element={<Drills />} />
        <Route path="seasons" element={<Seasons />} />
        <Route path="invite" element={<InviteCoach />} />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
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
