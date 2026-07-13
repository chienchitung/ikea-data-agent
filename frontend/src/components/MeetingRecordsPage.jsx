import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { FileAudio, Plus, Download, Trash2, Edit2, Check, CheckSquare, Loader2 } from 'lucide-react';
import { MeetingRecorderModal } from './MeetingRecorderModal';
import { MeetingMinutesView } from './MeetingMinutesView';

function formatRelativeTime(ts) {
    const now = Date.now();
    const diff = now - ts;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'Yesterday';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function MeetingRecordsPage({ apiUrl, geminiApiKey, groqApiKey, onOpenApiKeys }) {
    const [meetings, setMeetings] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [isWakingServer, setIsWakingServer] = useState(false);
    const [activeMeetingId, setActiveMeetingId] = useState(null);
    const [showRecorderModal, setShowRecorderModal] = useState(false);
    const [isSelecting, setIsSelecting] = useState(false);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [renamingMeetingId, setRenamingMeetingId] = useState(null);
    const [renamingTitle, setRenamingTitle] = useState('');
    const [isRenaming, setIsRenaming] = useState(false);
    // 遞增序號：使用者在重試迴圈進行中又按了 Try again 時，讓舊的迴圈
    // 自行退場，避免兩個迴圈交錯更新狀態。
    const fetchSeqRef = useRef(0);

    const fetchMeetings = useCallback(async () => {
        const seq = ++fetchSeqRef.current;
        setIsLoading(true);
        setLoadError(false);
        setIsWakingServer(false);

        // Without a timeout, a stalled request (e.g. one queued behind a
        // long-running chat stream to the same origin) left this spinner
        // running forever with no way to recover short of a page reload.
        //
        // 第一次嘗試用短 timeout；失敗多半是後端冷啟動或部署重啟
        // （Render 閒置喚醒常要 30~60 秒），所以改用長 timeout 自動重試
        // 兩次，而不是 15 秒就直接對使用者說載入失敗。
        const attempts = [
            { timeout: 15000, delayBefore: 0 },
            { timeout: 45000, delayBefore: 2000 },
            { timeout: 45000, delayBefore: 3000 },
        ];

        for (let i = 0; i < attempts.length; i++) {
            const { timeout, delayBefore } = attempts[i];
            if (delayBefore) await new Promise((resolve) => setTimeout(resolve, delayBefore));
            if (fetchSeqRef.current !== seq) return;
            try {
                const response = await axios.get(`${apiUrl}/meetings`, { timeout });
                if (fetchSeqRef.current !== seq) return;
                setMeetings(response.data.meetings || []);
                setIsWakingServer(false);
                setIsLoading(false);
                return;
            } catch (error) {
                if (fetchSeqRef.current !== seq) return;
                console.error(`Failed to fetch meetings (attempt ${i + 1}/${attempts.length}):`, error);
                if (i < attempts.length - 1) setIsWakingServer(true);
            }
        }

        setIsWakingServer(false);
        setLoadError(true);
        setIsLoading(false);
    }, [apiUrl]);

    useEffect(() => { fetchMeetings(); }, [fetchMeetings]);

    const startRenaming = (meeting) => {
        setRenamingMeetingId(meeting.meeting_id);
        setRenamingTitle(meeting.meeting_title || '');
    };

    // The PUT endpoint replaces meeting_data wholesale (no partial patch), so
    // renaming from this list — which only has the summary fields, not the
    // full agenda/notes/actions — has to fetch the full record first and send
    // it back with just meeting_title swapped, or it would wipe everything else.
    const confirmRenaming = async () => {
        if (!renamingMeetingId) return;
        const meetingId = renamingMeetingId;
        const newTitle = renamingTitle.trim();
        setIsRenaming(true);
        try {
            const { data: record } = await axios.get(`${apiUrl}/meetings/${encodeURIComponent(meetingId)}`);
            const updatedData = { ...(record.meeting_data || {}), meeting_title: newTitle };
            await axios.put(`${apiUrl}/meetings/${encodeURIComponent(meetingId)}`, { meeting_data: updatedData });
            setMeetings((prev) => prev.map((m) => m.meeting_id === meetingId ? { ...m, meeting_title: newTitle } : m));
            setRenamingMeetingId(null);
        } catch (error) {
            console.error('Failed to rename meeting:', error);
            alert('Could not rename this meeting record. Please try again.');
        } finally {
            setIsRenaming(false);
        }
    };

    const deleteMeeting = async (meetingId) => {
        if (!confirm('Are you sure you want to delete this meeting record?')) return;
        setMeetings((prev) => prev.filter((m) => m.meeting_id !== meetingId));
        try {
            await axios.delete(`${apiUrl}/meetings/${encodeURIComponent(meetingId)}`);
        } catch (error) {
            console.error('Failed to delete meeting:', error);
            await fetchMeetings();
        }
    };

    const toggleSelectMode = () => {
        setIsSelecting((prev) => !prev);
        setSelectedIds(new Set());
    };

    const toggleSelected = (meetingId) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(meetingId)) next.delete(meetingId); else next.add(meetingId);
            return next;
        });
    };

    const toggleSelectAll = () => {
        setSelectedIds((prev) =>
            prev.size === meetings.length && meetings.length > 0
                ? new Set()
                : new Set(meetings.map((m) => m.meeting_id))
        );
    };

    const deleteSelected = async () => {
        if (selectedIds.size === 0) return;
        if (!confirm(`Are you sure you want to delete ${selectedIds.size} meeting(s)?`)) return;

        const toDelete = [...selectedIds];
        setMeetings((prev) => prev.filter((m) => !toDelete.includes(m.meeting_id)));
        setSelectedIds(new Set());
        setIsSelecting(false);

        for (const meetingId of toDelete) {
            try {
                await axios.delete(`${apiUrl}/meetings/${encodeURIComponent(meetingId)}`);
            } catch (error) {
                console.error('Failed to delete meeting:', error);
            }
        }
        await fetchMeetings();
    };

    const downloadMeetingDocx = async (meetingId, meetingTitle) => {
        try {
            const response = await axios.get(`${apiUrl}/meetings/${encodeURIComponent(meetingId)}/download`, {
                responseType: 'blob',
            });
            const url = URL.createObjectURL(response.data);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${meetingTitle || 'Meeting Notes'}.docx`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Failed to download meeting minutes:', error);
            alert('Could not download the document. Please try again.');
        }
    };

    const handleMeetingGenerated = (payload) => {
        setShowRecorderModal(false);
        fetchMeetings();
        if (payload?.meeting_id) setActiveMeetingId(payload.meeting_id);
    };

    // Proactively sends people to set the Groq key instead of letting them
    // open the recorder, fill out the whole form, and only then discover
    // (from the disabled submit button) that transcription can't run at all.
    const handleAddRecording = () => {
        if (!groqApiKey?.trim()) {
            onOpenApiKeys();
            return;
        }
        setShowRecorderModal(true);
    };

    return (
        <div className="flex-1 overflow-y-auto bg-white">
            <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-6">
                <div className="flex items-center justify-between mb-1">
                    <h2 className="text-xl font-bold text-[#111111]">Meeting Records</h2>
                    {meetings.length > 0 && (
                        <button
                            onClick={toggleSelectMode}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${isSelecting ? 'bg-[#0058A3] text-white' : 'text-[#767676] hover:bg-[#F5F5F5]'}`}
                        >
                            <CheckSquare className="w-3.5 h-3.5" />
                            {isSelecting ? 'Exit select mode' : 'Select'}
                        </button>
                    )}
                </div>
                <p className="text-sm text-[#767676] mb-6">Record or upload a meeting and I'll turn it into a structured meeting minutes document.</p>

                <button
                    onClick={handleAddRecording}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-dashed border-[#DFDFDF] rounded-xl hover:bg-[#F5F5F5] transition-colors text-sm font-medium text-[#484848] mb-6"
                >
                    <Plus className="w-4 h-4" /> Add Meeting Recording
                </button>

                {isSelecting && meetings.length > 0 && (
                    <div className="flex items-center justify-between mb-3 px-1">
                        <button onClick={toggleSelectAll} className="flex items-center gap-2 hover:bg-[#F5F5F5] rounded py-1 px-1 transition-colors">
                            <div className={`w-4 h-4 rounded border-2 flex-shrink-0 ${selectedIds.size === meetings.length && meetings.length > 0 ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center`}>
                                {selectedIds.size === meetings.length && meetings.length > 0 && <Check className="w-2.5 h-2.5 text-white" />}
                            </div>
                            <span className="text-xs text-[#767676]">
                                {selectedIds.size === 0 ? 'Select all' : `${selectedIds.size} / ${meetings.length} selected`}
                            </span>
                        </button>
                        <button
                            onClick={deleteSelected}
                            disabled={selectedIds.size === 0}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 rounded-lg disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                        >
                            <Trash2 className="w-3.5 h-3.5" /> Delete selected
                        </button>
                    </div>
                )}

                {isLoading ? (
                    <div className="flex flex-col items-center gap-3 py-10">
                        <Loader2 className="w-6 h-6 animate-spin text-[#0058A3]" />
                        {isWakingServer && (
                            <p className="text-xs text-[#767676]">Server is waking up — retrying automatically…</p>
                        )}
                    </div>
                ) : loadError ? (
                    <div className="text-center py-14 border border-dashed border-[#DFDFDF] rounded-xl">
                        <p className="text-sm text-[#767676] mb-3">Could not load meeting records.</p>
                        <button
                            onClick={fetchMeetings}
                            className="text-sm text-[#0058A3] font-medium hover:underline"
                        >
                            Try again
                        </button>
                    </div>
                ) : meetings.length === 0 ? (
                    <div className="text-center py-14 border border-dashed border-[#DFDFDF] rounded-xl">
                        <FileAudio className="w-8 h-8 text-[#DFDFDF] mx-auto mb-2" />
                        <p className="text-sm text-[#767676]">No meeting minutes yet</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {meetings.map((meeting) => {
                            const isSelected = selectedIds.has(meeting.meeting_id);
                            return (
                                <div
                                    key={meeting.meeting_id}
                                    onClick={() => isSelecting ? toggleSelected(meeting.meeting_id) : setActiveMeetingId(meeting.meeting_id)}
                                    className="flex items-center gap-3 p-3 border border-[#DFDFDF] rounded-xl hover:bg-[#F5F5F5] cursor-pointer transition-colors group"
                                >
                                    {isSelecting && (
                                        <div className={`w-4 h-4 rounded border-2 flex-shrink-0 ${isSelected ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center transition-colors`}>
                                            {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                                        </div>
                                    )}
                                    <div className="w-9 h-9 bg-[#F5F5F5] rounded-full flex items-center justify-center flex-shrink-0">
                                        <FileAudio className="w-4 h-4 text-[#0058A3]" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-[#111111] truncate">{meeting.meeting_title || 'Meeting Notes'}</p>
                                        <p className="text-xs text-[#767676]">{meeting.date || formatRelativeTime(new Date(meeting.created_at).getTime())}</p>
                                    </div>
                                    {!isSelecting && (
                                        <div className="flex-shrink-0 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                            <button onClick={(e) => { e.stopPropagation(); startRenaming(meeting); }} className="p-1.5 hover:bg-white rounded-lg" title="Rename">
                                                <Edit2 className="w-3.5 h-3.5 text-[#484848]" />
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); downloadMeetingDocx(meeting.meeting_id, meeting.meeting_title); }} className="p-1.5 hover:bg-white rounded-lg" title="Download .docx">
                                                <Download className="w-3.5 h-3.5 text-[#484848]" />
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); deleteMeeting(meeting.meeting_id); }} className="p-1.5 hover:bg-red-100 rounded-lg" title="Delete">
                                                <Trash2 className="w-3.5 h-3.5 text-red-500" />
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {showRecorderModal && (
                <MeetingRecorderModal
                    apiUrl={apiUrl}
                    geminiApiKey={geminiApiKey}
                    groqApiKey={groqApiKey}
                    onClose={() => setShowRecorderModal(false)}
                    onGenerated={handleMeetingGenerated}
                />
            )}

            {activeMeetingId && (
                <MeetingMinutesView
                    apiUrl={apiUrl}
                    meetingId={activeMeetingId}
                    onClose={() => setActiveMeetingId(null)}
                />
            )}

            {/* ── Rename Meeting Modal ── */}
            {renamingMeetingId && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => !isRenaming && setRenamingMeetingId(null)}>
                    <div className="bg-white rounded-2xl p-6 w-[min(400px,calc(100vw-2rem))] shadow-2xl" onClick={e => e.stopPropagation()}>
                        <h3 className="text-base font-semibold text-[#111111] mb-1">Rename meeting</h3>
                        <p className="text-sm text-[#767676] mb-4">Enter a new name for this meeting record.</p>
                        <input
                            type="text"
                            value={renamingTitle}
                            onChange={e => setRenamingTitle(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') confirmRenaming();
                                if (e.key === 'Escape') setRenamingMeetingId(null);
                            }}
                            disabled={isRenaming}
                            className="w-full px-3 py-2 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] focus:border-transparent text-[#111111]"
                            autoFocus
                            onFocus={e => e.target.select()}
                        />
                        <div className="flex gap-2 mt-4 justify-end">
                            <button
                                onClick={() => setRenamingMeetingId(null)}
                                disabled={isRenaming}
                                className="px-4 py-2 text-sm font-medium text-[#111111] hover:bg-[#F5F5F5] rounded-lg transition-colors disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmRenaming}
                                disabled={isRenaming}
                                className="px-4 py-2 text-sm font-medium text-white bg-[#0058A3] hover:bg-[#004F93] rounded-lg transition-colors disabled:opacity-50"
                            >
                                {isRenaming ? 'Saving…' : 'Save'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
