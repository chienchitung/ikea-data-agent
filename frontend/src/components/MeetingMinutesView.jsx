import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, ChevronDown, Edit2, Download, Kanban } from 'lucide-react';
import { getMeetingRecord, updateMeetingRecordData, getMeetingAudioBlob } from '../utils/meetingStore';
import { hasImportedActionsForMeeting, syncActionItemsFromMeeting } from '../utils/actionItemStore';

function formatTimestamp(totalSeconds) {
    const total = Math.max(0, Math.floor(totalSeconds || 0));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function EditableTable({ headers, fields, rows, onChange, disabled }) {
    const updateCell = (rowIndex, field, value) => {
        onChange(rows.map((row, idx) => (idx === rowIndex ? { ...row, [field]: value } : row)));
    };
    const addRow = () => {
        const blank = Object.fromEntries(fields.map((f) => [f.key, '']));
        onChange([...rows, blank]);
    };
    const removeRow = (rowIndex) => {
        onChange(rows.filter((_, idx) => idx !== rowIndex));
    };

    return (
        <div className="markdown-table-scroll">
            <table className="w-full text-sm border-collapse">
                <thead>
                    <tr>
                        {headers.map((h) => (
                            <th key={h} className="border border-[#DFDFDF] bg-[#F5F5F5] px-2 py-1.5 text-left font-semibold text-[#111111]">{h}</th>
                        ))}
                        {!disabled && <th className="border border-[#DFDFDF] bg-[#F5F5F5] w-8" />}
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 && (
                        <tr>
                            <td colSpan={headers.length + (disabled ? 0 : 1)} className="border border-[#DFDFDF] px-2 py-2 text-center text-[#AAAAAA]">
                                No rows yet
                            </td>
                        </tr>
                    )}
                    {rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                            {fields.map((field) => (
                                <td key={field.key} className="border border-[#DFDFDF] px-2 py-1 align-top">
                                    {disabled ? (
                                        <span className="text-[#111111] whitespace-pre-wrap">{row[field.key] || ''}</span>
                                    ) : (
                                        <textarea
                                            value={row[field.key] ?? ''}
                                            onChange={(e) => updateCell(rowIndex, field.key, e.target.value)}
                                            rows={Math.max(1, String(row[field.key] ?? '').split('\n').length)}
                                            className="w-full bg-transparent focus:outline-none text-[#111111] resize-none block leading-normal"
                                        />
                                    )}
                                </td>
                            ))}
                            {!disabled && (
                                <td className="border border-[#DFDFDF] text-center">
                                    <button type="button" onClick={() => removeRow(rowIndex)} className="text-red-400 hover:text-red-600 text-xs" aria-label="Remove row">✕</button>
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
            {!disabled && (
                <button type="button" onClick={addRow} className="mt-1 text-xs text-[#0058A3] hover:underline">+ Add row</button>
            )}
        </div>
    );
}

function EditableNotes({ notes, onChange, disabled }) {
    const updateNote = (index, value) => onChange(notes.map((n, i) => (i === index ? value : n)));
    const addNote = () => onChange([...notes, '']);
    const removeNote = (index) => onChange(notes.filter((_, i) => i !== index));

    if (disabled) {
        return notes.length > 0 ? (
            <ul className="list-disc list-inside space-y-1 text-sm text-[#111111]">
                {notes.map((note, i) => <li key={i}>{note}</li>)}
            </ul>
        ) : <p className="text-sm text-[#AAAAAA]">No notes recorded.</p>;
    }

    return (
        <div className="space-y-1.5">
            {notes.map((note, i) => (
                <div key={i} className="flex items-start gap-2">
                    <span className="text-[#767676] mt-2">•</span>
                    <textarea
                        value={note}
                        onChange={(e) => updateNote(i, e.target.value)}
                        rows={2}
                        className="flex-1 text-sm border border-[#DFDFDF] rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[#0058A3] text-[#111111]"
                    />
                    <button type="button" onClick={() => removeNote(i)} className="text-red-400 hover:text-red-600 text-xs mt-2" aria-label="Remove note">✕</button>
                </div>
            ))}
            <button type="button" onClick={addNote} className="text-xs text-[#0058A3] hover:underline">+ Add note</button>
        </div>
    );
}

export function MeetingMinutesView({ apiUrl, meetingId, onClose }) {
    const [record, setRecord] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const [draftData, setDraftData] = useState(null);
    const [isSaving, setIsSaving] = useState(false);
    const [showTranscript, setShowTranscript] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
    const [audioUrl, setAudioUrl] = useState(null);
    const [actionsImported, setActionsImported] = useState(false);
    const [isImportingActions, setIsImportingActions] = useState(false);
    const audioRef = useRef(null);
    const segmentRefs = useRef([]);
    const segments = useMemo(() => record?.segments || [], [record]);

    // `<audio>` only mounts once showTranscript is true, but segments is usually
    // already loaded before that toggle happens — so this must depend on
    // showTranscript too, or the effect runs once while audioRef.current is
    // still null, bails out, and never re-attaches the listener afterward.
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || segments.length === 0) return;

        const onTimeUpdate = () => {
            const t = audio.currentTime;
            let index = -1;
            for (let i = 0; i < segments.length; i++) {
                const isLast = i === segments.length - 1;
                if (segments[i].start <= t && (isLast || segments[i + 1].start > t)) {
                    index = i;
                    break;
                }
            }
            setActiveSegmentIndex(index);
        };

        audio.addEventListener('timeupdate', onTimeUpdate);
        return () => audio.removeEventListener('timeupdate', onTimeUpdate);
    }, [segments, showTranscript]);

    // Keeps the currently-playing line visible inside the scrollable transcript
    // panel as playback progresses, instead of only highlighting it — without
    // this, the highlighted line can scroll out of view during long recordings
    // and the sync becomes invisible to the user.
    useEffect(() => {
        if (activeSegmentIndex < 0) return;
        segmentRefs.current[activeSegmentIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [activeSegmentIndex]);

    const seekToSegment = (index) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = segments[index].start;
        setActiveSegmentIndex(index);
        audio.play().catch(() => {});
    };

    // Record + audio now come from this browser's IndexedDB (see
    // meetingStore.js), not the backend — the backend only holds either
    // transiently, during generation.
    useEffect(() => {
        let cancelled = false;
        let objectUrl = null;
        setIsLoading(true);
        setLoadError('');
        setAudioUrl(null);

        (async () => {
            try {
                const [rec, audio, alreadyImported] = await Promise.all([
                    getMeetingRecord(meetingId),
                    getMeetingAudioBlob(meetingId),
                    hasImportedActionsForMeeting(meetingId),
                ]);
                if (cancelled) return;
                if (!rec) throw new Error('Meeting record not found.');
                setRecord(rec);
                setActionsImported(alreadyImported);
                if (audio?.blob) {
                    objectUrl = URL.createObjectURL(audio.blob);
                    setAudioUrl(objectUrl);
                }
            } catch (error) {
                if (cancelled) return;
                console.error('Failed to load meeting record:', error);
                setLoadError('Could not load this meeting record.');
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [meetingId]);

    const meetingData = isEditing ? draftData : record?.meeting_data;

    const startEditing = () => {
        setDraftData(JSON.parse(JSON.stringify(record.meeting_data)));
        setIsEditing(true);
    };

    const cancelEditing = () => {
        setDraftData(null);
        setIsEditing(false);
    };

    const updateField = (key, value) => {
        setDraftData((prev) => ({ ...prev, [key]: value }));
    };

    const saveEditing = async () => {
        setIsSaving(true);
        try {
            const updated = await updateMeetingRecordData(meetingId, draftData);
            setRecord(updated);
            setIsEditing(false);
            setDraftData(null);
        } catch (error) {
            console.error('Failed to save meeting minutes:', error);
            const message = error.name === 'QuotaExceededError'
                ? "Your browser's storage is full — free up space (delete some older recordings) and try again."
                : 'Could not save changes. Please try again.';
            alert(message);
        } finally {
            setIsSaving(false);
        }
    };

    // Syncs actions_review as-saved on record, not draftData — syncing
    // mid-edit would ship unsaved changes to the board silently. The button
    // is disabled while isEditing (see below) so this path shouldn't be
    // reachable, but guarding here too costs nothing. Safe to call
    // repeatedly: syncActionItemsFromMeeting matches rows to existing cards
    // by a stable id, so re-syncing updates already-linked cards in place
    // and only creates new ones for rows that don't have a card yet (see
    // its doc comment in actionItemStore.js).
    const handleImportActions = async () => {
        if (!record) return;
        setIsImportingActions(true);
        try {
            const result = await syncActionItemsFromMeeting(record);
            setRecord(result.record);
            setActionsImported(true);
        } catch (error) {
            console.error('Failed to sync action items:', error);
            alert('Could not sync action items to the board. Please try again.');
        } finally {
            setIsImportingActions(false);
        }
    };

    // Docx generation is stateless server-side now — meeting_data goes in the
    // request body since the backend no longer keeps its own copy to look up.
    const handleDownload = async () => {
        setIsDownloading(true);
        try {
            const res = await fetch(`${apiUrl}/meetings/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ meeting_data: record?.meeting_data || {} }),
            });
            if (!res.ok) throw new Error('Download failed.');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            const title = record?.meeting_data?.meeting_title || 'Meeting Notes';
            link.download = `${title}.docx`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Failed to download meeting minutes:', error);
            alert('Could not download the document. Please try again.');
        } finally {
            setIsDownloading(false);
        }
    };

    // Unlike the .docx download, the transcript is plain text already sitting
    // in `record` (from IndexedDB) — no backend round-trip needed, just wrap
    // it in a Blob and trigger a download the same way.
    const handleTranscriptDownload = () => {
        if (!record?.transcript) return;
        const blob = new Blob([record.transcript], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const title = record?.meeting_data?.meeting_title || 'Meeting Notes';
        link.download = `${title} - Transcript.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                {isLoading ? (
                    <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-[#0058A3]" /></div>
                ) : loadError || !meetingData ? (
                    <div className="p-10 text-center text-sm text-red-500">{loadError || 'This meeting record is unavailable.'}</div>
                ) : (
                    <>
                        <div className="p-6 border-b border-[#DFDFDF] flex items-start justify-between sticky top-0 bg-white z-10">
                            <div className="min-w-0 flex-1 mr-3">
                                {isEditing ? (
                                    <input
                                        type="text"
                                        value={meetingData.meeting_title || ''}
                                        onChange={(e) => updateField('meeting_title', e.target.value)}
                                        className="text-lg font-semibold text-[#111111] border-b border-[#DFDFDF] focus:outline-none focus:border-[#0058A3] w-full"
                                    />
                                ) : (
                                    <h2 className="text-lg font-semibold text-[#111111] truncate">{meetingData.meeting_title || 'Meeting Notes'}</h2>
                                )}
                                <p className="text-xs text-[#767676] mt-1">{[meetingData.date, meetingData.time].filter(Boolean).join(' · ')}</p>
                            </div>
                            <button onClick={onClose} className="p-1 hover:bg-[#F5F5F5] rounded-full transition-colors flex-shrink-0" aria-label="Close">
                                <X className="w-5 h-5 text-[#767676]" />
                            </button>
                        </div>

                        <div className="p-6 space-y-5">
                            <div className="grid grid-cols-2 gap-3 text-sm">
                                {[
                                    ['note_taker', 'Note taker'],
                                    ['attendees', 'In attendance'],
                                    ['apologies', 'Apologies for absence'],
                                ].map(([key, label]) => (
                                    <div key={key} className={key === 'apologies' ? 'col-span-2' : ''}>
                                        <span className="text-xs font-semibold text-[#767676] uppercase tracking-wide">{label}</span>
                                        {isEditing ? (
                                            <input
                                                type="text"
                                                value={meetingData[key] || ''}
                                                onChange={(e) => updateField(key, e.target.value)}
                                                className="w-full mt-1 px-2 py-1 border border-[#DFDFDF] rounded focus:outline-none focus:ring-2 focus:ring-[#0058A3] text-[#111111]"
                                            />
                                        ) : (
                                            <p className="text-[#111111] mt-0.5">{meetingData[key] || '—'}</p>
                                        )}
                                    </div>
                                ))}
                            </div>

                            <section>
                                <h3 className="text-sm font-semibold text-[#111111] mb-2">Last time actions review</h3>
                                <EditableTable
                                    headers={['No.', 'Action items', 'Assigned to', 'Feedback']}
                                    fields={[{ key: 'no' }, { key: 'item' }, { key: 'assigned_to' }, { key: 'feedback' }]}
                                    rows={meetingData.last_time_actions || []}
                                    onChange={(rows) => updateField('last_time_actions', rows)}
                                    disabled={!isEditing}
                                />
                            </section>

                            <section>
                                <h3 className="text-sm font-semibold text-[#111111] mb-2">Meeting Agenda</h3>
                                <EditableTable
                                    headers={['No.', 'Agenda items', 'Presenter/Owner']}
                                    fields={[{ key: 'no' }, { key: 'item' }, { key: 'owner' }]}
                                    rows={meetingData.agenda || []}
                                    onChange={(rows) => updateField('agenda', rows)}
                                    disabled={!isEditing}
                                />
                            </section>

                            <section>
                                <h3 className="text-sm font-semibold text-[#111111] mb-2">Executive Summary</h3>
                                {isEditing ? (
                                    <textarea
                                        value={meetingData.executive_summary || ''}
                                        onChange={(e) => updateField('executive_summary', e.target.value)}
                                        rows={4}
                                        className="w-full text-sm border border-[#DFDFDF] rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[#0058A3] text-[#111111]"
                                        placeholder="A short narrative summary of the meeting"
                                    />
                                ) : meetingData.executive_summary ? (
                                    <p className="text-sm text-[#111111] leading-relaxed whitespace-pre-wrap">{meetingData.executive_summary}</p>
                                ) : (
                                    <p className="text-sm text-[#AAAAAA]">No summary recorded.</p>
                                )}
                            </section>

                            <section>
                                <h3 className="text-sm font-semibold text-[#111111] mb-2">Meeting Notes</h3>
                                <EditableNotes
                                    notes={meetingData.notes || []}
                                    onChange={(notes) => updateField('notes', notes)}
                                    disabled={!isEditing}
                                />
                            </section>

                            <section>
                                <div className="flex items-center justify-between mb-2">
                                    <h3 className="text-sm font-semibold text-[#111111]">Actions review</h3>
                                    {(meetingData.actions_review || []).length > 0 && !isEditing && (
                                        <button
                                            type="button"
                                            onClick={handleImportActions}
                                            disabled={isImportingActions}
                                            className="flex items-center gap-1 text-xs font-medium text-[#0058A3] hover:underline transition-colors disabled:cursor-default disabled:no-underline disabled:opacity-60"
                                        >
                                            {isImportingActions ? (
                                                <Loader2 className="w-3 h-3 animate-spin" />
                                            ) : (
                                                <Kanban className="w-3 h-3" />
                                            )}
                                            {actionsImported ? 'Sync to Action Items board' : 'Import to Action Items board'}
                                        </button>
                                    )}
                                </div>
                                <EditableTable
                                    headers={['No.', 'Action items', 'Assigned to', 'Deadline']}
                                    fields={[{ key: 'no' }, { key: 'item' }, { key: 'assigned_to' }, { key: 'deadline' }]}
                                    rows={meetingData.actions_review || []}
                                    onChange={(rows) => updateField('actions_review', rows)}
                                    disabled={!isEditing}
                                />
                            </section>

                            <section>
                                <div className="flex items-center justify-between">
                                    <button
                                        type="button"
                                        onClick={() => setShowTranscript((v) => !v)}
                                        className="flex items-center gap-1 text-xs font-semibold text-[#767676] hover:text-[#111111]"
                                    >
                                        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showTranscript ? '' : '-rotate-90'}`} />
                                        View transcript
                                    </button>
                                    {record?.transcript && (
                                        <button
                                            type="button"
                                            onClick={handleTranscriptDownload}
                                            className="flex items-center gap-1 text-xs font-medium text-[#0058A3] hover:underline"
                                        >
                                            <Download className="w-3 h-3" />
                                            Download transcript (.txt)
                                        </button>
                                    )}
                                </div>
                                {showTranscript && (
                                    <div className="mt-2">
                                        {audioUrl && <audio ref={audioRef} controls src={audioUrl} className="w-full mb-2" />}
                                        {segments.length > 0 ? (
                                            <div className="text-xs bg-[#F5F5F5] rounded-lg p-2 max-h-64 overflow-y-auto space-y-1">
                                                {segments.map((seg, i) => (
                                                    <button
                                                        key={i}
                                                        ref={(el) => { segmentRefs.current[i] = el; }}
                                                        type="button"
                                                        onClick={() => seekToSegment(i)}
                                                        className={`w-full flex items-start gap-2 text-left px-2 py-1 rounded transition-colors hover:bg-white ${activeSegmentIndex === i ? 'bg-[#0058A3]/10 ring-1 ring-inset ring-[#0058A3]/40' : ''}`}
                                                    >
                                                        <span className="font-mono text-[#0058A3] flex-shrink-0">{formatTimestamp(seg.start)}</span>
                                                        {seg.speaker && <span className="font-semibold text-[#484848] flex-shrink-0">{seg.speaker}:</span>}
                                                        <span className="text-[#111111]">{seg.text}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        ) : (
                                            <pre className="text-xs text-[#484848] whitespace-pre-wrap bg-[#F5F5F5] rounded-lg p-3 max-h-48 overflow-y-auto">{record.transcript}</pre>
                                        )}
                                    </div>
                                )}
                            </section>
                        </div>

                        <div className="px-6 pb-6 flex items-center justify-between gap-2 sticky bottom-0 bg-white">
                            <div>
                                {isEditing ? (
                                    <>
                                        <button onClick={cancelEditing} disabled={isSaving} className="px-4 py-2 text-sm font-medium text-[#111111] hover:bg-[#F5F5F5] rounded-lg transition-colors">
                                            Cancel
                                        </button>
                                        <button onClick={saveEditing} disabled={isSaving} className="ml-2 px-4 py-2 text-sm font-medium text-white bg-[#0058A3] hover:bg-[#004F93] rounded-lg transition-colors">
                                            {isSaving ? 'Saving…' : 'Save'}
                                        </button>
                                    </>
                                ) : (
                                    <button onClick={startEditing} className="px-4 py-2 text-sm font-medium text-[#111111] hover:bg-[#F5F5F5] rounded-lg transition-colors flex items-center gap-1.5">
                                        <Edit2 className="w-3.5 h-3.5" /> Edit
                                    </button>
                                )}
                            </div>
                            <button
                                onClick={handleDownload}
                                disabled={isDownloading || isEditing}
                                className="px-4 py-2 text-sm font-medium text-white bg-[#0058A3] hover:bg-[#004F93] rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                            >
                                {isDownloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                                Download .docx
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
