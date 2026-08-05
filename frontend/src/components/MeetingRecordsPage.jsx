import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { FileAudio, Plus, Download, Upload, Trash2, Edit2, Check, CheckSquare, Loader2, AlertTriangle, X, Search } from 'lucide-react';
import { MeetingMinutesView } from './MeetingMinutesView';
import {
    listMeetingRecords,
    getMeetingRecord,
    updateMeetingRecordData,
    deleteMeetingRecord,
    getMeetingStorageBreakdown,
    getStorageEstimate,
    exportMeetingRecords,
    importMeetingRecords,
    STORAGE_WARNING_THRESHOLD,
} from '../utils/meetingStore';

function formatMb(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const mb = bytes / (1024 * 1024);
    if (mb >= 100) return `${Math.round(mb).toLocaleString()} MB`;
    return `${mb.toFixed(1)} MB`;
}

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

export function MeetingRecordsPage({ apiUrl, groqApiKey, onOpenApiKeys, initialMeetingId, onOpenRecorder }) {
    const [meetings, setMeetings] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [activeMeetingId, setActiveMeetingId] = useState(() => initialMeetingId || null);
    const [isSelecting, setIsSelecting] = useState(false);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [renamingMeetingId, setRenamingMeetingId] = useState(null);
    const [renamingTitle, setRenamingTitle] = useState('');
    const [isRenaming, setIsRenaming] = useState(false);
    // Storage-capacity warning: null until measured, then { usage, quota,
    // breakdown } once over STORAGE_WARNING_THRESHOLD. Dismissing just hides
    // it for this page visit — it comes back next load if still over.
    const [storageWarning, setStorageWarning] = useState(null);
    const [isStorageWarningDismissed, setIsStorageWarningDismissed] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [isExporting, setIsExporting] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [importProgress, setImportProgress] = useState(null);
    const importFileInputRef = useRef(null);

    // Matches against title and full transcript — listMeetingRecords() already
    // carries transcript for free (see meetingStore.js), so this needs no
    // extra IndexedDB reads.
    const filteredMeetings = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        if (!query) return meetings;
        return meetings.filter((m) =>
            (m.meeting_title || '').toLowerCase().includes(query) ||
            (m.transcript || '').toLowerCase().includes(query)
        );
    }, [meetings, searchQuery]);

    // Meeting records + audio live in the browser's IndexedDB now (see
    // meetingStore.js), not on the backend — Render's disk is ephemeral, so
    // anything kept server-side was disappearing on every redeploy/restart.
    // Reading from IndexedDB is local and fast, so none of the previous
    // multi-attempt "server is waking up" retry logic (needed for a real
    // network call to a possibly-sleeping Render instance) applies anymore.
    const fetchMeetings = useCallback(async () => {
        setIsLoading(true);
        setLoadError(false);
        try {
            const records = await listMeetingRecords();
            setMeetings(records);
        } catch (error) {
            console.error('Failed to load meeting records from this browser:', error);
            setLoadError(true);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => { fetchMeetings(); }, [fetchMeetings]);

    // The recorder modal is now owned by App.jsx (so it survives navigating
    // away from this page — see onOpenRecorder), but this page itself can
    // still be reached without a fresh mount: a completion toast's "View"
    // button, or the Action Items board's "open source meeting" link, both
    // route through App.jsx's openMeetingId state and may target a page
    // that's already showing. Watch initialMeetingId for changes instead of
    // only reading it once so those deep links work even without a remount,
    // and refetch since a newly-generated meeting wouldn't otherwise appear
    // in the list until this page happens to remount.
    useEffect(() => {
        if (!initialMeetingId) return;
        setActiveMeetingId(initialMeetingId);
        fetchMeetings();
    }, [initialMeetingId, fetchMeetings]);

    const checkStorageCapacity = useCallback(async () => {
        const estimate = await getStorageEstimate();
        if (!estimate || estimate.usage / estimate.quota < STORAGE_WARNING_THRESHOLD) {
            setStorageWarning(null);
            return;
        }
        const breakdown = await getMeetingStorageBreakdown();
        setStorageWarning({ ...estimate, breakdown: breakdown.slice(0, 5) });
    }, []);

    useEffect(() => { checkStorageCapacity(); }, [checkStorageCapacity, meetings]);

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
            const record = await getMeetingRecord(meetingId);
            if (!record) throw new Error('Meeting record not found.');
            const updatedData = { ...(record.meeting_data || {}), meeting_title: newTitle };
            await updateMeetingRecordData(meetingId, updatedData);
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
            await deleteMeetingRecord(meetingId);
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

    // Selects/clears only the currently-filtered (visible) meetings, not
    // every meeting regardless of the search box — selecting something the
    // user can't currently see would be surprising.
    const toggleSelectAll = () => {
        setSelectedIds((prev) =>
            prev.size === filteredMeetings.length && filteredMeetings.length > 0
                ? new Set()
                : new Set(filteredMeetings.map((m) => m.meeting_id))
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
                await deleteMeetingRecord(meetingId);
            } catch (error) {
                console.error('Failed to delete meeting:', error);
            }
        }
        await fetchMeetings();
    };

    // Docx generation itself still has to happen server-side (python-docx),
    // but statelessly now: the record lives here in the browser, so this
    // sends meeting_data in the request body instead of the backend looking
    // it up by id.
    const downloadMeetingDocx = async (meetingId, meetingTitle) => {
        try {
            const record = await getMeetingRecord(meetingId);
            if (!record) throw new Error('Meeting record not found.');
            const response = await axios.post(
                `${apiUrl}/meetings/download`,
                { meeting_data: record.meeting_data || {} },
                { responseType: 'blob' },
            );
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

    // Records only live in this browser's IndexedDB now — no server copy to
    // fall back on — so this is the only way to move them to a new device or
    // recover from a cleared browser profile. meetingIds omitted exports
    // everything; passed in (e.g. the current selection) exports a subset.
    const downloadBackupFile = async (meetingIds) => {
        setIsExporting(true);
        try {
            const blob = await exportMeetingRecords(meetingIds);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            const dateStr = new Date().toISOString().slice(0, 10);
            link.download = `meeting-records-backup-${dateStr}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Failed to export meeting records:', error);
            alert('Could not export meeting records. Please try again.');
        } finally {
            setIsExporting(false);
        }
    };

    const handleExportAll = () => downloadBackupFile();
    const handleExportSelected = () => downloadBackupFile([...selectedIds]);

    const handleImportFileChosen = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // otherwise re-picking the same file no-ops (no change event)
        if (!file) return;

        setIsImporting(true);
        setImportProgress({ done: 0, total: 0 });
        try {
            const count = await importMeetingRecords(file, (done, total) => setImportProgress({ done, total }));
            await fetchMeetings();
            alert(`Imported ${count} meeting record${count === 1 ? '' : 's'}. Any that already existed here were overwritten with the backup's version.`);
        } catch (error) {
            console.error('Failed to import meeting records:', error);
            alert(error.message || 'Could not import this file. Please make sure it is a meeting-records backup exported from this app.');
        } finally {
            setIsImporting(false);
            setImportProgress(null);
        }
    };

    // Proactively sends people to set the Groq key instead of letting them
    // open the recorder, fill out the whole form, and only then discover
    // (from the disabled submit button) that transcription can't run at all.
    const handleAddRecording = () => {
        if (!groqApiKey?.trim()) {
            onOpenApiKeys();
            return;
        }
        onOpenRecorder();
    };

    return (
        <div className="flex-1 overflow-y-auto bg-white">
            <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-6">
                <div className="flex items-center justify-between mb-1 gap-2">
                    <h2 className="text-xl font-bold text-[#111111]">Meeting Records</h2>
                    <div className="flex items-center gap-1 flex-shrink-0">
                        {meetings.length > 0 && (
                            <button
                                onClick={handleExportAll}
                                disabled={isExporting}
                                title="Export all meeting records as a backup file"
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[#767676] hover:bg-[#F5F5F5] transition-colors disabled:opacity-50"
                            >
                                {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                Export
                            </button>
                        )}
                        <button
                            onClick={() => importFileInputRef.current?.click()}
                            disabled={isImporting}
                            title="Import meeting records from a backup file"
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[#767676] hover:bg-[#F5F5F5] transition-colors disabled:opacity-50"
                        >
                            {isImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                            {isImporting && importProgress?.total
                                ? `Importing ${importProgress.done}/${importProgress.total}…`
                                : 'Import'}
                        </button>
                        <input
                            ref={importFileInputRef}
                            type="file"
                            accept=".json,application/json"
                            className="hidden"
                            onChange={handleImportFileChosen}
                        />
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
                </div>
                <p className="text-sm text-[#767676] mb-1">Record or upload a meeting and I'll turn it into a structured meeting minutes document.</p>
                <p className="text-xs text-[#AAAAAA] mb-6">
                    Records are saved in this browser only — export a backup periodically, or before switching devices or clearing browser data.
                </p>

                {storageWarning && !isStorageWarningDismissed && (
                    <div className="mb-6 border border-amber-200 bg-amber-50 rounded-xl p-4">
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-2.5 min-w-0">
                                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-amber-800">
                                        Your browser's storage is almost full ({formatMb(storageWarning.usage)} / {formatMb(storageWarning.quota)})
                                    </p>
                                    <p className="text-xs text-amber-700 mt-1">
                                        Meeting recordings are saved in this browser, and it's running low on space. Delete some
                                        older recordings below to keep saving new ones.
                                    </p>
                                    {storageWarning.breakdown.length > 0 && (
                                        <ul className="mt-2 space-y-1">
                                            {storageWarning.breakdown.map((item) => (
                                                <li key={item.meeting_id} className="flex items-center justify-between gap-2 text-xs">
                                                    <span className="text-amber-800 truncate">{item.title}</span>
                                                    <div className="flex items-center gap-2 flex-shrink-0">
                                                        <span className="text-amber-600 tabular-nums">{formatMb(item.bytes)}</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => deleteMeeting(item.meeting_id)}
                                                            className="text-amber-700 hover:text-amber-900 font-medium hover:underline"
                                                        >
                                                            Delete
                                                        </button>
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsStorageWarningDismissed(true)}
                                className="p-1 hover:bg-amber-100 rounded-full transition-colors flex-shrink-0"
                                aria-label="Dismiss"
                            >
                                <X className="w-4 h-4 text-amber-600" />
                            </button>
                        </div>
                    </div>
                )}

                <button
                    onClick={handleAddRecording}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-dashed border-[#DFDFDF] rounded-xl hover:bg-[#F5F5F5] transition-colors text-sm font-medium text-[#484848] mb-6"
                >
                    <Plus className="w-4 h-4" /> Add Meeting Recording
                </button>

                {meetings.length > 0 && (
                    <div className="relative mb-4">
                        <Search className="w-4 h-4 text-[#AAAAAA] absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search by title or transcript…"
                            className="w-full pl-9 pr-3 py-2 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] focus:border-transparent text-[#111111]"
                        />
                    </div>
                )}

                {isSelecting && filteredMeetings.length > 0 && (
                    <div className="flex items-center justify-between mb-3 px-1">
                        <button onClick={toggleSelectAll} className="flex items-center gap-2 hover:bg-[#F5F5F5] rounded py-1 px-1 transition-colors">
                            <div className={`w-4 h-4 rounded border-2 flex-shrink-0 ${selectedIds.size === filteredMeetings.length && filteredMeetings.length > 0 ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center`}>
                                {selectedIds.size === filteredMeetings.length && filteredMeetings.length > 0 && <Check className="w-2.5 h-2.5 text-white" />}
                            </div>
                            <span className="text-xs text-[#767676]">
                                {selectedIds.size === 0 ? 'Select all' : `${selectedIds.size} / ${filteredMeetings.length} selected`}
                            </span>
                        </button>
                        <div className="flex items-center gap-1">
                        <button
                            onClick={handleExportSelected}
                            disabled={selectedIds.size === 0 || isExporting}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#767676] hover:bg-[#F5F5F5] rounded-lg disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                        >
                            <Download className="w-3.5 h-3.5" /> Export selected
                        </button>
                        <button
                            onClick={deleteSelected}
                            disabled={selectedIds.size === 0}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 rounded-lg disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                        >
                            <Trash2 className="w-3.5 h-3.5" /> Delete selected
                        </button>
                        </div>
                    </div>
                )}

                {isLoading ? (
                    <div className="flex flex-col items-center gap-3 py-10">
                        <Loader2 className="w-6 h-6 animate-spin text-[#0058A3]" />
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
                ) : filteredMeetings.length === 0 ? (
                    <div className="text-center py-14 border border-dashed border-[#DFDFDF] rounded-xl">
                        <Search className="w-8 h-8 text-[#DFDFDF] mx-auto mb-2" />
                        <p className="text-sm text-[#767676]">No meeting records match "{searchQuery.trim()}"</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {filteredMeetings.map((meeting) => {
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
