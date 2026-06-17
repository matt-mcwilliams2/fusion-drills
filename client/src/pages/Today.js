import React, { useState, useEffect, useCallback } from 'react';
import confetti from 'canvas-confetti';
import { useAuth } from '../context/AuthContext';

function getYouTubeEmbedUrl(url) {
  if (!url) return null;
  // Already an embed URL
  if (url.includes('/embed/')) return url;
  // Standard watch URL
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
  if (match) return `https://www.youtube.com/embed/${match[1]}`;
  return url;
}

export default function Today() {
  const { apiFetch } = useAuth();
  const [drill, setDrill] = useState(null);
  const [completion, setCompletion] = useState(null);
  const [didExtra, setDidExtra] = useState(false);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [streak, setStreak] = useState(null);

  const fetchToday = useCallback(async () => {
    try {
      const data = await apiFetch('/api/drills/today');
      setDrill(data.drill);
      setCompletion(data.completion);
      if (data.completion) {
        // fetch stats to get current streak
        const stats = await apiFetch('/api/me/stats');
        setStreak(stats.current_streak);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    fetchToday();
  }, [fetchToday]);

  const handleComplete = async () => {
    if (!drill || completing) return;
    setCompleting(true);
    try {
      const data = await apiFetch(`/api/drills/${drill.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ did_extra: didExtra }),
      });
      setCompletion(data.completion);

      // Confetti burst
      confetti({
        particleCount: 150,
        spread: 80,
        origin: { y: 0.7 },
        colors: ['#f77c00', '#1348e5', '#ffffff', '#22c55e'],
      });

      // Fetch streak after completion
      const stats = await apiFetch('/api/me/stats');
      setStreak(stats.current_streak);
    } catch (err) {
      console.error(err);
    } finally {
      setCompleting(false);
    }
  };

  if (loading) {
    return <div className="page"><div className="loading"><div className="spinner" /></div></div>;
  }

  if (!drill) {
    return (
      <div className="page">
        <div className="rest-day">
          <div className="rest-day-icon">😴</div>
          <h2>Rest Day</h2>
          <p>No drill scheduled for today. Recover and come back stronger!</p>
        </div>
      </div>
    );
  }

  const formatDate = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  };

  if (completion) {
    return (
      <div className="page">
        <div className="card">
          <div className="card-date">{formatDate(drill.date)}</div>
          <h2 className="card-title">{drill.title}</h2>
          <p className="card-desc">{drill.description}</p>
          {drill.youtube_url && (
            <div className="video-wrapper">
              <iframe
                src={getYouTubeEmbedUrl(drill.youtube_url)}
                title={drill.title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          )}
          <div className="completion-state">
            <div className="completion-check">✓</div>
            <div className="completion-msg">You crushed it today!</div>
            {streak && <div className="completion-streak">🔥 {streak} day streak</div>}
            {completion.did_extra && <div className="completion-extra">⭐ Extra time logged</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card">
        <div className="card-date">{formatDate(drill.date)}</div>
        <h2 className="card-title">{drill.title}</h2>
        <p className="card-desc">{drill.description}</p>
        {drill.youtube_url && (
          <div className="video-wrapper">
            <iframe
              src={getYouTubeEmbedUrl(drill.youtube_url)}
              title={drill.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        )}
      </div>
      <label className="extra-check">
        <input
          type="checkbox"
          checked={didExtra}
          onChange={(e) => setDidExtra(e.target.checked)}
        />
        <span className="extra-check-label">I did 15+ extra minutes</span>
      </label>
      <div className="mt-12">
        <button
          className="btn btn-orange did-it-btn"
          onClick={handleComplete}
          disabled={completing}
        >
          {completing ? 'Saving...' : '⚽ I did it!'}
        </button>
      </div>
    </div>
  );
}
