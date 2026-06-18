import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';

const emptyQuestion = () => ({
  question_text: '',
  input_type: 'text',
  point_value: '1',
  options: [],
  acceptable_answers: [],
});

export default function Drills() {
  const { apiFetch } = useAuth();
  const [drills, setDrills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ date: '', title: '', description: '', youtube_url: '', target_time: '', points_completion: '10', points_extra: '5', is_challenge: false });
  const [hasQuestions, setHasQuestions] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [saving, setSaving] = useState(false);

  const loadDrills = async () => {
    try {
      const data = await apiFetch('/api/admin/drills');
      setDrills(data.drills);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadDrills(); }, []);

  const openAdd = () => {
    setEditing(null);
    setForm({ date: '', title: '', description: '', youtube_url: '', target_time: '', points_completion: '10', points_extra: '5', is_challenge: false });
    setHasQuestions(false);
    setQuestions([]);
    setShowModal(true);
  };

  const openEdit = async (drill) => {
    setEditing(drill);
    setForm({ date: (drill.date || '').split('T')[0], title: drill.title, description: drill.description || '', youtube_url: drill.youtube_url || '', target_time: drill.target_time || '', points_completion: drill.points_completion != null ? drill.points_completion : '10', points_extra: drill.points_extra != null ? drill.points_extra : '5', is_challenge: drill.is_challenge || false });
    // Load existing questions
    try {
      const data = await apiFetch(`/api/admin/drills/${drill.id}/questions`);
      if (data.questions && data.questions.length > 0) {
        setHasQuestions(true);
        setQuestions(data.questions.map(q => ({
          id: q.id,
          question_text: q.question_text,
          input_type: q.input_type,
          point_value: String(q.point_value),
          options: q.options || [],
          acceptable_answers: q.acceptable_answers || [],
        })));
      } else {
        setHasQuestions(false);
        setQuestions([]);
      }
    } catch (err) {
      console.error(err);
      setHasQuestions(false);
      setQuestions([]);
    }
    setShowModal(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      let drillId;
      if (editing) {
        const result = await apiFetch(`/api/admin/drills/${editing.id}`, { method: 'PUT', body: JSON.stringify(form) });
        drillId = result.id;
      } else {
        const result = await apiFetch('/api/admin/drills', { method: 'POST', body: JSON.stringify(form) });
        drillId = result.id;
      }
      // Save questions
      const questionsToSave = hasQuestions ? questions : [];
      await apiFetch(`/api/admin/drills/${drillId}/questions`, {
        method: 'PUT',
        body: JSON.stringify({ questions: questionsToSave }),
      });
      setShowModal(false);
      loadDrills();
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this drill? Completions for this drill will also be removed.')) return;
    try {
      await apiFetch(`/api/admin/drills/${id}`, { method: 'DELETE' });
      loadDrills();
    } catch (err) { alert(err.message); }
  };

  // Question helpers
  const addQuestion = () => {
    if (questions.length >= 20) return;
    setQuestions([...questions, emptyQuestion()]);
  };

  const updateQuestion = (index, field, value) => {
    const updated = [...questions];
    updated[index] = { ...updated[index], [field]: value };
    // Reset options/answers when type changes
    if (field === 'input_type') {
      if (value === 'text') {
        updated[index].options = [];
        if (updated[index].acceptable_answers.length === 0) {
          updated[index].acceptable_answers = [];
        }
      } else {
        updated[index].acceptable_answers = [];
        if (updated[index].options.length === 0) {
          updated[index].options = [];
        }
      }
    }
    setQuestions(updated);
  };

  const removeQuestion = (index) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const addOption = (qIndex) => {
    const updated = [...questions];
    updated[qIndex] = { ...updated[qIndex], options: [...updated[qIndex].options, { option_text: '', is_correct: false }] };
    setQuestions(updated);
  };

  const updateOption = (qIndex, oIndex, field, value) => {
    const updated = [...questions];
    const opts = [...updated[qIndex].options];
    opts[oIndex] = { ...opts[oIndex], [field]: value };
    // For radio: only one correct answer allowed
    if (field === 'is_correct' && value && updated[qIndex].input_type === 'radio') {
      opts.forEach((o, i) => { if (i !== oIndex) opts[i] = { ...o, is_correct: false }; });
    }
    updated[qIndex] = { ...updated[qIndex], options: opts };
    setQuestions(updated);
  };

  const removeOption = (qIndex, oIndex) => {
    const updated = [...questions];
    updated[qIndex] = { ...updated[qIndex], options: updated[qIndex].options.filter((_, i) => i !== oIndex) };
    setQuestions(updated);
  };

  const addAcceptableAnswer = (qIndex) => {
    const updated = [...questions];
    updated[qIndex] = { ...updated[qIndex], acceptable_answers: [...updated[qIndex].acceptable_answers, { answer_text: '' }] };
    setQuestions(updated);
  };

  const updateAcceptableAnswer = (qIndex, aIndex, value) => {
    const updated = [...questions];
    const answers = [...updated[qIndex].acceptable_answers];
    answers[aIndex] = { ...answers[aIndex], answer_text: value };
    updated[qIndex] = { ...updated[qIndex], acceptable_answers: answers };
    setQuestions(updated);
  };

  const removeAcceptableAnswer = (qIndex, aIndex) => {
    const updated = [...questions];
    updated[qIndex] = { ...updated[qIndex], acceptable_answers: updated[qIndex].acceptable_answers.filter((_, i) => i !== aIndex) };
    setQuestions(updated);
  };

  const toDateOnly = (dateStr) => (dateStr || '').split('T')[0];

  const formatDate = (dateStr) => {
    const d = new Date(toDateOnly(dateStr) + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (loading) return <div className="admin-page"><div className="loading"><div className="spinner" /></div></div>;

  return (
    <div className="admin-page">
      <div className="flex-between mb-16">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Drills</h1>
        <button className="btn btn-orange btn-sm" onClick={openAdd}>+ Add Drill</button>
      </div>

      {drills.map((d) => (
        <div key={d.id} className="drill-row">
          <div className="drill-row-header">
            <span className="drill-row-date">{formatDate(d.date)}{d.is_challenge && <span className="challenge-badge-sm">Challenge</span>}</span>
          </div>
          <div className="drill-row-title">{d.title}</div>
          <div className="drill-row-actions">
            <button className="btn btn-outline btn-sm" onClick={() => openEdit(d)}>Edit</button>
            <button className="btn btn-danger btn-sm" onClick={() => handleDelete(d.id)}>Delete</button>
          </div>
        </div>
      ))}

      {drills.length === 0 && <div className="no-season-msg">No drills scheduled yet.</div>}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>{editing ? 'Edit Drill' : 'Add Drill'}</h2>
            <form onSubmit={handleSave}>
              <div className="form-group">
                <label className="form-label">Date</label>
                <input className="form-input" type="date" value={form.date} onChange={(e) => setForm({...form, date: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">Title</label>
                <input className="form-input" value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} required />
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <textarea className="form-textarea" value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} />
              </div>
              <div className="form-group">
                <label className="form-label">YouTube URL</label>
                <input className="form-input" value={form.youtube_url} onChange={(e) => setForm({...form, youtube_url: e.target.value})} placeholder="https://youtube.com/watch?v=..." />
              </div>
              <div className="form-group">
                <label className="form-label">Target Time (minutes)</label>
                <input className="form-input" type="number" min="1" value={form.target_time} onChange={(e) => setForm({...form, target_time: e.target.value})} placeholder="e.g. 15" />
              </div>
              <label className="form-checkbox">
                <input type="checkbox" checked={form.is_challenge} onChange={(e) => setForm({...form, is_challenge: e.target.checked})} />
                <span>Challenge Day</span>
              </label>
              <div className="form-row">
                <div className="form-group form-group-half">
                  <label className="form-label">Points: Completion</label>
                  <input className="form-input" type="number" min="0" value={form.points_completion} onChange={(e) => setForm({...form, points_completion: e.target.value})} />
                </div>
                <div className="form-group form-group-half">
                  <label className="form-label">Points: Extra 15 min</label>
                  <input className="form-input" type="number" min="0" value={form.points_extra} onChange={(e) => setForm({...form, points_extra: e.target.value})} />
                </div>
              </div>

              {/* Questions Toggle */}
              <label className="form-checkbox">
                <input type="checkbox" checked={hasQuestions} onChange={(e) => {
                  setHasQuestions(e.target.checked);
                  if (e.target.checked && questions.length === 0) {
                    setQuestions([emptyQuestion()]);
                  }
                }} />
                <span>Add Questions?</span>
              </label>

              {/* Question Builder */}
              {hasQuestions && (
                <div className="question-builder">
                  {questions.map((q, qi) => (
                    <div key={qi} className="question-card">
                      <div className="question-header">
                        <span className="question-number">Question {qi + 1}</span>
                        <button type="button" className="btn-remove" onClick={() => removeQuestion(qi)}>Remove</button>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Question Text</label>
                        <input className="form-input" value={q.question_text} onChange={(e) => updateQuestion(qi, 'question_text', e.target.value)} placeholder="Enter your question..." required />
                      </div>
                      <div className="form-row">
                        <div className="form-group form-group-half">
                          <label className="form-label">Input Type</label>
                          <select className="form-input" value={q.input_type} onChange={(e) => updateQuestion(qi, 'input_type', e.target.value)}>
                            <option value="text">Text Box</option>
                            <option value="radio">Radio Buttons</option>
                            <option value="checkbox">Checkboxes</option>
                          </select>
                        </div>
                        <div className="form-group form-group-half">
                          <label className="form-label">{q.input_type === 'checkbox' ? 'Points Per Correct' : 'Point Value'}</label>
                          <input className="form-input" type="number" min="1" value={q.point_value} onChange={(e) => updateQuestion(qi, 'point_value', e.target.value)} />
                        </div>
                      </div>

                      {/* Text Box: Acceptable Answers */}
                      {q.input_type === 'text' && (
                        <div className="question-answers-section">
                          <label className="form-label">Acceptable Answers</label>
                          <div className="question-warning">Add every reasonable variation you would accept. Players must match one of your answers exactly (case-insensitive, extra spaces ignored).</div>
                          {q.acceptable_answers.map((a, ai) => (
                            <div key={ai} className="option-row">
                              <input className="form-input" value={a.answer_text} onChange={(e) => updateAcceptableAnswer(qi, ai, e.target.value)} placeholder="Acceptable answer..." />
                              <button type="button" className="btn-remove-sm" onClick={() => removeAcceptableAnswer(qi, ai)}>x</button>
                            </div>
                          ))}
                          <button type="button" className="btn btn-outline btn-sm add-option-btn" onClick={() => addAcceptableAnswer(qi)}>+ Add Answer</button>
                        </div>
                      )}

                      {/* Radio: Options */}
                      {q.input_type === 'radio' && (
                        <div className="question-answers-section">
                          <label className="form-label">Answer Options</label>
                          {q.options.map((o, oi) => (
                            <div key={oi} className="option-row">
                              <label className="option-correct-label" title="Correct answer">
                                <input type="radio" name={`q${qi}_correct`} checked={o.is_correct} onChange={() => updateOption(qi, oi, 'is_correct', true)} />
                              </label>
                              <input className="form-input" value={o.option_text} onChange={(e) => updateOption(qi, oi, 'option_text', e.target.value)} placeholder="Option text..." />
                              <button type="button" className="btn-remove-sm" onClick={() => removeOption(qi, oi)}>x</button>
                            </div>
                          ))}
                          <button type="button" className="btn btn-outline btn-sm add-option-btn" onClick={() => addOption(qi)}>+ Add Option</button>
                        </div>
                      )}

                      {/* Checkbox: Options */}
                      {q.input_type === 'checkbox' && (
                        <div className="question-answers-section">
                          <label className="form-label">Answer Options</label>
                          <div className="question-warning">Players earn points for each correct answer they select.</div>
                          {q.options.map((o, oi) => (
                            <div key={oi} className="option-row">
                              <label className="option-correct-label" title="Correct answer">
                                <input type="checkbox" checked={o.is_correct} onChange={(e) => updateOption(qi, oi, 'is_correct', e.target.checked)} />
                              </label>
                              <input className="form-input" value={o.option_text} onChange={(e) => updateOption(qi, oi, 'option_text', e.target.value)} placeholder="Option text..." />
                              <button type="button" className="btn-remove-sm" onClick={() => removeOption(qi, oi)}>x</button>
                            </div>
                          ))}
                          <button type="button" className="btn btn-outline btn-sm add-option-btn" onClick={() => addOption(qi)}>+ Add Option</button>
                        </div>
                      )}
                    </div>
                  ))}
                  {questions.length < 20 && (
                    <button type="button" className="btn btn-outline btn-sm" onClick={addQuestion} style={{ width: '100%' }}>
                      + Add Question ({questions.length}/20)
                    </button>
                  )}
                </div>
              )}

              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-orange" disabled={saving}>{saving ? 'Saving...' : (editing ? 'Update' : 'Add Drill')}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
