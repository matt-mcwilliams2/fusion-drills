import React, { useState, useEffect, useCallback } from 'react';
import confetti from 'canvas-confetti';
import { useAuth } from '../context/AuthContext';
import LevelShield from '../components/LevelShield';

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
  const [celebration, setCelebration] = useState(null);

  // Quiz state
  const [quizActive, setQuizActive] = useState(false);
  const [quizQuestions, setQuizQuestions] = useState([]);
  const [quizIndex, setQuizIndex] = useState(0);
  const [quizTotalCount, setQuizTotalCount] = useState(0);
  const [quizAnswer, setQuizAnswer] = useState('');
  const [quizSelectedIds, setQuizSelectedIds] = useState([]);
  const [quizSubmitting, setQuizSubmitting] = useState(false);
  const [quizFeedback, setQuizFeedback] = useState(null);
  const [quizPointsEarned, setQuizPointsEarned] = useState(0);
  const [quizComplete, setQuizComplete] = useState(false);
  // Store completion data for celebration after quiz
  const [pendingCelebration, setPendingCelebration] = useState(null);

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

  const triggerCelebration = (data) => {
    confetti({
      particleCount: 150,
      spread: 80,
      origin: { y: 0.7 },
      colors: ['#f77c00', '#1348e5', '#ffffff', '#22c55e'],
    });

    if (data.levelUp) {
      confetti({
        particleCount: 300,
        spread: 120,
        origin: { y: 0.5 },
        colors: ['#f77c00', '#1348e5', '#FFD700', '#22c55e', '#FF69B4'],
      });
      setCelebration({ type: 'levelUp', level: data.levelUp });
      setTimeout(() => setCelebration(null), 4000);
    } else if (data.newBadges && data.newBadges.length > 0) {
      setCelebration({ type: 'badge', count: data.newBadges.length });
      setTimeout(() => setCelebration(null), 4000);
    }
  };

  const handleComplete = async () => {
    if (!drill || completing || !canComplete) return;
    setCompleting(true);
    try {
      const data = await apiFetch(`/api/drills/${drill.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ did_extra: didExtra }),
      });
      setCompletion(data.completion);

      const stats = await apiFetch('/api/me/stats');
      setStreak(stats.current_streak);

      // Check if drill has questions
      if (drill.has_questions) {
        try {
          const qData = await apiFetch(`/api/drills/${drill.id}/questions`);
          if (qData.questions && qData.questions.length > 0) {
            // Start quiz - defer celebration until after quiz
            setPendingCelebration(data);
            setQuizQuestions(qData.questions);
            setQuizTotalCount(qData.total_count);
            setQuizIndex(0);
            setQuizAnswer('');
            setQuizSelectedIds([]);
            setQuizFeedback(null);
            setQuizPointsEarned(0);
            setQuizComplete(false);
            setQuizActive(true);
            // Fire confetti for drill completion
            confetti({
              particleCount: 150,
              spread: 80,
              origin: { y: 0.7 },
              colors: ['#f77c00', '#1348e5', '#ffffff', '#22c55e'],
            });
            return;
          }
        } catch (err) {
          console.error('Failed to load questions:', err);
        }
      }

      // No questions - show celebration immediately
      triggerCelebration(data);
    } catch (err) {
      console.error(err);
    } finally {
      setCompleting(false);
    }
  };

  const currentQuestion = quizQuestions[quizIndex] || null;

  const handleQuizSubmit = async () => {
    if (!currentQuestion || quizSubmitting) return;
    setQuizSubmitting(true);
    try {
      const body = {};
      if (currentQuestion.input_type === 'text') {
        body.answer = quizAnswer;
      } else {
        body.selected_option_ids = quizSelectedIds;
      }

      const result = await apiFetch(`/api/drills/questions/${currentQuestion.id}/answer`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (currentQuestion.input_type === 'checkbox') {
        // Show checkbox results immediately
        setQuizFeedback({
          type: 'checkbox_result',
          option_results: result.option_results,
          points_earned: result.points_earned,
        });
        setQuizPointsEarned(prev => prev + result.points_earned);
      } else if (result.correct) {
        setQuizFeedback({
          type: 'correct',
          points_earned: result.points_earned,
        });
        setQuizPointsEarned(prev => prev + result.points_earned);
      } else if (result.can_retry) {
        setQuizFeedback({
          type: 'retry',
          message: result.message,
        });
        setQuizAnswer('');
        setQuizSelectedIds([]);
        // Mark the current question as a retry
        const updated = [...quizQuestions];
        updated[quizIndex] = { ...updated[quizIndex], is_retry: true };
        setQuizQuestions(updated);
        // Clear feedback after a short delay so inputs reappear
        setTimeout(() => {
          setQuizFeedback(null);
        }, 1500);
        setQuizSubmitting(false);
        return;
      } else {
        // Wrong on second try - show correct answer
        setQuizFeedback({
          type: 'wrong',
          correct_answers: result.correct_answers,
          points_earned: result.points_earned,
        });
        setQuizPointsEarned(prev => prev + result.points_earned);
      }

      // Auto-advance after delay
      setTimeout(() => {
        advanceQuiz();
      }, 2000);
    } catch (err) {
      console.error(err);
    } finally {
      setQuizSubmitting(false);
    }
  };

  const handleQuizSkip = () => {
    advanceQuiz();
  };

  const advanceQuiz = () => {
    setQuizFeedback(null);
    setQuizAnswer('');
    setQuizSelectedIds([]);
    if (quizIndex + 1 < quizQuestions.length) {
      setQuizIndex(quizIndex + 1);
    } else {
      setQuizComplete(true);
    }
  };

  const finishQuiz = async () => {
    setQuizActive(false);
    setQuizComplete(false);
    // Re-fetch stats to get updated points
    try {
      const stats = await apiFetch('/api/me/stats');
      setStreak(stats.current_streak);
    } catch (err) { console.error(err); }
    // Trigger celebration from drill completion
    if (pendingCelebration) {
      // Re-check badges/level since question points may have changed things
      try {
        const stats = await apiFetch('/api/me/stats');
        setStreak(stats.current_streak);
      } catch (err) { console.error(err); }
      triggerCelebration(pendingCelebration);
      setPendingCelebration(null);
    }
  };

  const toggleCheckboxOption = (optionId) => {
    setQuizSelectedIds(prev =>
      prev.includes(optionId) ? prev.filter(id => id !== optionId) : [...prev, optionId]
    );
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
          <div className="card-date">{formatDateHeading(drill.date)}{drill.is_challenge && <span className="challenge-badge">Challenge Day</span>}</div>
          <h2 className="card-title">{drill.title}</h2>
          <p className="card-desc">{drill.description}</p>
          {drill.target_time && <div className="card-target-time">Target Time: {drill.target_time} min</div>}
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
          <div className="card-date">{formatDateHeading(drill.date)}{drill.is_challenge && <span className="challenge-badge">Challenge Day</span>}</div>
          <h2 className="card-title">{drill.title}</h2>
          <p className="card-desc">{drill.description}</p>
          {drill.target_time && <div className="card-target-time">Target Time: {drill.target_time} min</div>}
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
            <div className="mt-12" style={{ textAlign: 'center' }}>
              <button
                className="btn btn-orange did-it-btn"
                onClick={handleComplete}
                disabled={completing}
              >
                {completing ? 'Saving...' : drill.target_time ? `\u26BD I did ${drill.target_time} minutes!` : '\u26BD I did it!'}
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

  const renderQuizOverlay = () => {
    if (!quizActive) return null;

    if (quizComplete) {
      return (
        <div className="quiz-overlay">
          <div className="quiz-card">
            <div className="quiz-complete-emoji">{'\uD83C\uDF89'}</div>
            <div className="quiz-complete-title">Quiz Complete!</div>
            <div className="quiz-complete-points">
              You earned <span className="quiz-points-highlight">+{quizPointsEarned}</span> bonus points
            </div>
            <button className="btn btn-orange" style={{ width: '100%', marginTop: 20 }} onClick={finishQuiz}>Continue</button>
          </div>
        </div>
      );
    }

    if (!currentQuestion) return null;

    const questionNumber = quizIndex + 1;

    return (
      <div className="quiz-overlay">
        <div className="quiz-card">
          <div className="quiz-progress">Question {questionNumber} of {quizQuestions.length}</div>
          <div className="quiz-question-text">{currentQuestion.question_text}</div>
          {currentQuestion.is_retry && !quizFeedback && (
            <div className="quiz-retry-hint">Second attempt - half points</div>
          )}

          {/* Text input */}
          {currentQuestion.input_type === 'text' && !quizFeedback && (
            <input
              className="form-input quiz-input"
              value={quizAnswer}
              onChange={(e) => setQuizAnswer(e.target.value)}
              placeholder="Type your answer..."
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleQuizSubmit(); } }}
            />
          )}

          {/* Radio options */}
          {currentQuestion.input_type === 'radio' && !quizFeedback && (
            <div className="quiz-options">
              {currentQuestion.options.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`quiz-option ${quizSelectedIds.includes(opt.id) ? 'selected' : ''}`}
                  onClick={() => setQuizSelectedIds([opt.id])}
                >
                  <span className="quiz-option-radio">{quizSelectedIds.includes(opt.id) ? '\u25C9' : '\u25CB'}</span>
                  {opt.option_text}
                </button>
              ))}
            </div>
          )}

          {/* Checkbox options */}
          {currentQuestion.input_type === 'checkbox' && !quizFeedback && (
            <div className="quiz-options">
              {currentQuestion.options.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`quiz-option ${quizSelectedIds.includes(opt.id) ? 'selected' : ''}`}
                  onClick={() => toggleCheckboxOption(opt.id)}
                >
                  <span className="quiz-option-check">{quizSelectedIds.includes(opt.id) ? '\u2611' : '\u2610'}</span>
                  {opt.option_text}
                </button>
              ))}
            </div>
          )}

          {/* Feedback */}
          {quizFeedback && quizFeedback.type === 'correct' && (
            <div className="quiz-feedback correct">
              <div className="quiz-feedback-icon">{'\u2713'}</div>
              <div className="quiz-feedback-text">Correct! +{quizFeedback.points_earned} pts</div>
            </div>
          )}

          {quizFeedback && quizFeedback.type === 'retry' && (
            <div className="quiz-feedback retry">
              <div className="quiz-feedback-text">{quizFeedback.message}</div>
            </div>
          )}

          {quizFeedback && quizFeedback.type === 'wrong' && (
            <div className="quiz-feedback wrong">
              <div className="quiz-feedback-text">
                The correct answer{quizFeedback.correct_answers.length > 1 ? 's' : ''}: {quizFeedback.correct_answers.join(', ')}
              </div>
              {quizFeedback.points_earned > 0 && (
                <div className="quiz-feedback-points">+{quizFeedback.points_earned} pts (half credit)</div>
              )}
            </div>
          )}

          {quizFeedback && quizFeedback.type === 'checkbox_result' && (
            <div className="quiz-feedback checkbox-result">
              {quizFeedback.option_results.map((opt) => (
                <div key={opt.id} className={`quiz-result-row ${opt.is_correct && opt.was_selected ? 'correct' : opt.was_selected && !opt.is_correct ? 'wrong-pick' : opt.is_correct ? 'missed' : ''}`}>
                  <span className="quiz-result-icon">
                    {opt.was_selected && opt.is_correct ? '\u2713' : opt.was_selected && !opt.is_correct ? '\u2717' : opt.is_correct ? '\u25CB' : ''}
                  </span>
                  <span className="quiz-result-text">{opt.option_text}</span>
                  {opt.points_earned > 0 && <span className="quiz-result-points">+{opt.points_earned}</span>}
                </div>
              ))}
              <div className="quiz-feedback-points" style={{ marginTop: 8 }}>+{quizFeedback.points_earned} pts total</div>
            </div>
          )}

          {/* Actions */}
          {!quizFeedback && (
            <div className="quiz-actions">
              <button type="button" className="btn btn-outline" onClick={handleQuizSkip}>Skip</button>
              <button
                type="button"
                className="btn btn-orange"
                onClick={handleQuizSubmit}
                disabled={quizSubmitting || (currentQuestion.input_type === 'text' ? !quizAnswer.trim() : quizSelectedIds.length === 0)}
              >
                {quizSubmitting ? 'Checking...' : 'Submit'}
              </button>
            </div>
          )}
        </div>
      </div>
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

      {renderQuizOverlay()}

      {celebration && (
        <div className="celebration-overlay" onClick={() => setCelebration(null)}>
          <div className="celebration-card">
            {celebration.type === 'levelUp' ? (
              <>
                <LevelShield
                  name={celebration.level.name}
                  color={celebration.level.color}
                  textColor={celebration.level.textColor}
                  isPrestige={celebration.level.isPrestige}
                  subtitle={celebration.level.subtitle}
                  size="large"
                />
                <div className="celebration-title">Level Up!</div>
                <div className="celebration-msg">You reached {celebration.level.name}!</div>
              </>
            ) : (
              <>
                <div className="celebration-emoji">{'\uD83C\uDFC5'}</div>
                <div className="celebration-title">Badge Earned!</div>
                <div className="celebration-msg">
                  You earned {celebration.count} new badge{celebration.count > 1 ? 's' : ''}! Check your profile.
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
