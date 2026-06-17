import React, { useState, useEffect, useCallback } from 'react';
import confetti from 'canvas-confetti';
import { useAuth } from '../context/AuthContext';

function getYouTubeEmbedUrl(url) {
  if (!url) return null;
  if (url.includes('/embed/')) return url;
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
  if (match) return `https://www.youtube.com/embed/${match[1]}`;
  return url;
}

function toDateOnly(dateStr) {
  return (dateStr || '').split('T')[0];
}

function getLocalToday() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function getLocalYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

export default function Today() {
  const { apiFetch } = useAuth();
  const [selectedDate, setSelectedDate] = useState(getLocalToday());
  const [drill, setDrill] = useState(null);
  const [completion, setCompletion] = useState(null);
  const [didExtra, setDidExtra] = useState(false);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [streak, setStreak] = useState(null);

  const today = getLocalToday();
  const yesterday = getLocalYesterday();
  const canComplete = selectedDate === today || selectedDate === yesterday;
  const isToday = selectedDate === today;
  const isFuture = selectedDate > today;

  const fetchDrill = useCallback(async (date) => {
    setLoading(true);
    try {
      const data = await apiFetch(`/api/drills/date/${date}`);
      setDrill(data.drill);
      setCompletion(data.completion);
      setDidExtra(false);
      if (data.completion) {
        const stats = await apiFetch('/api/me/stats');
        setStreak(stats.current_streak);
      } else {
        setStreak(null);
      }
    } catch (err) {
      console.error(err);
      setDrill(null);
      setCompletion(null);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    fetchDrill(selectedDate);
  }, [selectedDate, fetchDrill]);

  const goToPrev = () => setSelectedDate(shiftDate(selectedDate, -1));
  const goToNext = () => {
    if (!isToday) setSelectedDate(shiftDate(selectedDate, 1));
  };
  const goToToday = () => setSelectedDate(today);

  const handleComplete = async () => {
    if (!drill || completing || !canComplete) return;
    setCompleting(true);
    try {
      const data = await apiFetch(`/api/drills/${drill.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ did_extra: didExtra }),
      });
      setCompletion(data.completion);

      confetti({
        particleCount: 150,
        spread: 80,
        origin: { y: 0.7 },
        colors: ['#f77c00', '#1348e5', '#ffffff', '#22c55e'],
      });

      const stats = await apiFetch('/api/me/stats');
      setStreak(stats.current_streak);
    } catch (err) {
      console.error(err);
    } finally {
      setCompleting(false);
    }
  };

  const formatDateHeading = (dateStr) => {
    const d = new Date(toDateOnly(dateStr) + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  };

  const formatDateShort = (dateStr) => {
    const d = new Date(toDateOnly(dateStr) + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const getDateLabel = () => {
    if (selectedDate === today) return 'Today';
    if (selectedDate === yesterday) return 'Yesterday';
    return formatDateShort(selectedDate);
  };

  const renderDrillContent = () => {
    if (loading) {
      return <div className="loading"><div className="spinner" /></div>;
    }

    if (!drill) {
      return (
        <div className="rest-day">
          <div className="rest-day-icon">{isFuture ? '...' : '\uD83D\uDE34'}</div>
          <h2>{isFuture ? 'Coming Soon' : 'Rest Day'}</h2>
          <p>{isFuture
            ? 'This drill hasn\'t been posted yet. Check back later!'
            : 'No drill was scheduled for this day.'
          }</p>
        </div>
      );
    }

    if (completion) {
      return (
        <div className="card">
          <div className="card-date">{formatDateHeading(drill.date)}</div>
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
            <div className="completion-check">{'\u2713'}</div>
            <div className="completion-msg">{isToday ? 'You crushed it today!' : 'Completed!'}</div>
            {streak && isToday && <div className="completion-streak">{'\uD83D\uDD25'} {streak} day streak</div>}
            {completion.did_extra && <div className="completion-extra">{'\u2B50'} Extra time logged</div>}
          </div>
        </div>
      );
    }

    return (
      <>
        <div className="card">
          <div className="card-date">{formatDateHeading(drill.date)}</div>
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
        {canComplete ? (
          <>
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
                {completing ? 'Saving...' : '\u26BD I did it!'}
              </button>
            </div>
          </>
        ) : (
          <div className="view-only-msg">
            You can only complete today's or yesterday's drill.
          </div>
        )}
      </>
    );
  };

  return (
    <div className="page">
      <div className="date-nav">
        <button className="date-nav-btn" onClick={goToPrev}>{'\u2039'}</button>
        <button className="date-nav-label" onClick={goToToday}>
          {getDateLabel()}
        </button>
        <button className="date-nav-btn" onClick={goToNext} disabled={isToday}>{'\u203A'}</button>
      </div>
      {renderDrillContent()}
    </div>
  );
}
