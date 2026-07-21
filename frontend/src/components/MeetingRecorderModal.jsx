import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Upload, X, Loader2, RotateCcw } from 'lucide-react';
import { readSseStream } from '../utils/sse';

const PROGRESS_LABELS = {
    uploading_audio: 'Uploading recording…',
    normalizing_audio: 'Preparing audio…',
    splitting_audio: 'Splitting audio for transcription…',
    transcribing: 'Transcribing audio…',
    drafting_minutes: 'Drafting meeting minutes…',
};

// Mirrors the backend's GROQ_MAX_UPLOAD_BYTES (backend/agents/meeting.py) — the
// original file size isn't exactly what that check runs against (the backend
// checks the normalized mp3, not this raw upload/recording), so this is only
// used as a rough heuristic for whether to show the "this may take a few
// stages" hint before the server has reported any real progress.
const GROQ_CHUNKING_THRESHOLD_BYTES = 20 * 1024 * 1024;

function formatSeconds(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// groqApiKey is set from the Meeting Records page, not here — this modal only
// reads it (to send with the request and to disable submit when it's missing).
export function MeetingRecorderModal({ apiUrl, geminiApiKey, groqApiKey, onClose, onGenerated }) {
    const [mode, setMode] = useState('upload');
    const [selectedFile, setSelectedFile] = useState(null);
    const [recordedBlob, setRecordedBlob] = useState(null);
    const [recordedUrl, setRecordedUrl] = useState(null);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingSeconds, setRecordingSeconds] = useState(0);

    const [meetingTitle, setMeetingTitle] = useState('');
    const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
    const [time, setTime] = useState('');
    const [noteTaker, setNoteTaker] = useState('');
    const [attendees, setAttendees] = useState('');
    const [apologies, setApologies] = useState('');

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [progressLabel, setProgressLabel] = useState('');
    // null = indeterminate (no chunk-level progress to report yet, e.g. short
    // recordings that transcribe in a single request); 0-100 = determinate.
    const [progressPercent, setProgressPercent] = useState(null);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [errorMessage, setErrorMessage] = useState('');
    const [errorDetails, setErrorDetails] = useState('');

    // Audio prep (upload + normalize) runs automatically the moment a file is
    // picked or a recording finishes, instead of waiting for "Generate
    // Meeting Minutes" — see the effect below. 'idle' | 'preparing' | 'ready' | 'error'.
    const [prepStatus, setPrepStatus] = useState('idle');
    const [prepMeetingId, setPrepMeetingId] = useState(null);
    const [prepProgressLabel, setPrepProgressLabel] = useState('');
    const [prepError, setPrepError] = useState('');

    const mediaRecorderRef = useRef(null);
    const streamRef = useRef(null);
    const chunksRef = useRef([]);
    const timerRef = useRef(null);
    const elapsedTimerRef = useRef(null);
    const abortControllerRef = useRef(null);
    const prepAbortControllerRef = useRef(null);
    // Mirrors prepMeetingId, but readable synchronously from effect cleanup /
    // unmount (state reads there would be stale). Non-null means "this
    // meeting_id has prepared audio on the server but no saved meeting record
    // yet" — i.e. it's an orphan if we walk away now and must be deleted.
    // Cleared to null (without deleting) the moment generation actually
    // succeeds, since at that point it's a real, kept meeting record.
    const prepMeetingIdRef = useRef(null);

    // Aborts any in-flight prepare call and deletes the server-side prepared
    // audio for a meeting_id that never made it to a saved meeting record.
    // Safe to call repeatedly (e.g. from both an effect and unmount).
    const cleanupOrphanedPrep = () => {
        prepAbortControllerRef.current?.abort();
        const orphanedId = prepMeetingIdRef.current;
        prepMeetingIdRef.current = null;
        if (orphanedId) {
            fetch(`${apiUrl}/meetings/${orphanedId}`, { method: 'DELETE' }).catch(() => {});
        }
    };

    useEffect(() => {
        return () => {
            clearInterval(timerRef.current);
            clearInterval(elapsedTimerRef.current);
            streamRef.current?.getTracks().forEach((track) => track.stop());
            if (recordedUrl) URL.revokeObjectURL(recordedUrl);
            abortControllerRef.current?.abort();
            cleanupOrphanedPrep();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Kicks off audio prep (upload + normalize) automatically whenever the
    // selected file or finished recording changes, instead of waiting for the
    // user to click "Generate Meeting Minutes". By the time they've filled in
    // the form and clicked it, prep has usually already finished, so that
    // click can go straight into transcribing.
    useEffect(() => {
        const source = mode === 'upload' ? selectedFile : recordedBlob;

        cleanupOrphanedPrep();
        setPrepMeetingId(null);
        setPrepStatus(source ? 'preparing' : 'idle');
        setPrepProgressLabel('');
        setPrepError('');

        if (!source) return undefined;

        const controller = new AbortController();
        prepAbortControllerRef.current = controller;

        (async () => {
            try {
                const formData = new FormData();
                if (mode === 'record') {
                    const ext = source.type?.includes('mp4') ? 'm4a' : 'webm';
                    formData.append('audio', source, `recording.${ext}`);
                } else {
                    formData.append('audio', source);
                }

                const response = await fetch(`${apiUrl}/meetings/prepare-audio/stream`, {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal,
                });

                if (!response.ok) {
                    const data = await response.json().catch(() => null);
                    throw new Error(data?.detail?.message || data?.message || `Request failed with status ${response.status}`);
                }

                let finalPayload = null;
                let errorPayload = null;

                await readSseStream(response, (event, data) => {
                    if (event === 'progress') {
                        const percent = typeof data?.percent === 'number' ? data.percent : null;
                        const baseLabel = PROGRESS_LABELS[data?.phase] || data?.label || 'Preparing audio…';
                        setPrepProgressLabel(percent != null ? `${baseLabel} ${percent}%` : baseLabel);
                    } else if (event === 'final') {
                        finalPayload = data;
                    } else if (event === 'error') {
                        errorPayload = data;
                    }
                });

                if (errorPayload) throw new Error(errorPayload.message || 'Could not prepare this recording.');
                if (!finalPayload?.meeting_id) throw new Error('Audio preparation ended without a result.');

                prepMeetingIdRef.current = finalPayload.meeting_id;
                setPrepMeetingId(finalPayload.meeting_id);
                setPrepStatus('ready');
            } catch (error) {
                if (error.name === 'AbortError') return;
                console.error('Audio prepare failed:', error);
                setPrepStatus('error');
                setPrepError(error.message || 'Could not prepare this recording.');
            }
        })();

        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode === 'upload' ? selectedFile : recordedBlob]);

    const discardRecording = () => {
        if (recordedUrl) URL.revokeObjectURL(recordedUrl);
        setRecordedBlob(null);
        setRecordedUrl(null);
        setRecordingSeconds(0);
    };

    const startRecording = async () => {
        setErrorMessage('');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            chunksRef.current = [];

            const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
                .find((candidate) => window.MediaRecorder?.isTypeSupported?.(candidate));
            const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunksRef.current.push(e.data);
            };
            recorder.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
                discardRecording();
                setRecordedBlob(blob);
                setRecordedUrl(URL.createObjectURL(blob));
                streamRef.current?.getTracks().forEach((track) => track.stop());
                streamRef.current = null;
            };

            recorder.start();
            mediaRecorderRef.current = recorder;
            setIsRecording(true);
            setRecordingSeconds(0);
            timerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
        } catch (error) {
            console.error('Microphone access failed:', error);
            setErrorMessage('Could not access the microphone. Please allow microphone permission in your browser and try again.');
        }
    };

    const stopRecording = () => {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
        clearInterval(timerRef.current);
    };

    // No audio file here — /meetings/generate/stream now transcribes whatever
    // /meetings/prepare-audio/stream already uploaded and normalized for
    // prepMeetingId (see the effect above), identified by meeting_id alone.
    const buildMetadataFormData = () => {
        const formData = new FormData();
        formData.append('meeting_id', prepMeetingId);
        formData.append('meeting_title', meetingTitle);
        formData.append('date', date);
        formData.append('time', time);
        formData.append('note_taker', noteTaker);
        formData.append('attendees', attendees);
        formData.append('apologies', apologies);
        if (geminiApiKey) formData.append('gemini_api_key', geminiApiKey);
        formData.append('groq_api_key', (groqApiKey || '').trim());
        return formData;
    };

    const hasAudio = mode === 'upload' ? !!selectedFile : !!recordedBlob;
    const hasGroqKey = !!(groqApiKey || '').trim();
    const audioFileBytes = mode === 'upload' ? (selectedFile?.size || 0) : (recordedBlob?.size || 0);

    // Cancel is always clickable, including mid-generation: abort the in-flight
    // request (the fetch's AbortController) if one is running, then close.
    // Aborting resolves readSseStream's await with an AbortError, which the
    // catch block below already treats as a silent, expected cancellation.
    // Also cleans up any prepared-but-unused audio so it doesn't linger
    // server-side with no meeting record ever attached to it.
    const handleCancel = () => {
        abortControllerRef.current?.abort();
        cleanupOrphanedPrep();
        onClose();
    };

    const handleSubmit = async () => {
        if (!hasAudio || !hasGroqKey || isSubmitting || prepStatus !== 'ready') return;
        setIsSubmitting(true);
        setErrorMessage('');
        setErrorDetails('');
        setProgressLabel('Transcribing audio…');
        setProgressPercent(null);
        setElapsedSeconds(0);
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);

        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
            const response = await fetch(`${apiUrl}/meetings/generate/stream`, {
                method: 'POST',
                body: buildMetadataFormData(),
                signal: controller.signal,
            });

            if (!response.ok) {
                const data = await response.json().catch(() => null);
                const failure = new Error(data?.detail?.message || data?.message || `Request failed with status ${response.status}`);
                failure.details = data?.detail?.details || data?.details;
                throw failure;
            }

            let finalPayload = null;
            let errorPayload = null;

            await readSseStream(response, (event, data) => {
                if (event === 'progress') {
                    const percent = typeof data?.percent === 'number' ? data.percent : null;
                    const baseLabel = PROGRESS_LABELS[data?.phase] || data?.label || 'Processing…';
                    setProgressLabel(percent != null ? `${baseLabel} ${percent}%` : baseLabel);
                    setProgressPercent(percent);
                } else if (event === 'final') {
                    finalPayload = data;
                } else if (event === 'error') {
                    errorPayload = data;
                }
            });

            if (errorPayload) {
                const failure = new Error(errorPayload.message || 'Meeting minutes generation failed.');
                failure.details = errorPayload.details;
                throw failure;
            }
            if (!finalPayload) {
                throw new Error('Stream ended before a final response was returned.');
            }

            // This meeting_id now has a real, saved meeting record — clear the
            // orphan tracker before onGenerated() (which the parent responds to
            // by unmounting this modal) so the unmount cleanup doesn't delete
            // the meeting record it's referencing.
            prepMeetingIdRef.current = null;
            onGenerated(finalPayload);
        } catch (error) {
            if (error.name === 'AbortError') return;
            console.error('Meeting generation failed:', error);
            setErrorMessage(error.message || 'Something went wrong while generating meeting minutes.');
            setErrorDetails(typeof error.details === 'string' ? error.details : (error.details ? JSON.stringify(error.details) : ''));
        } finally {
            clearInterval(elapsedTimerRef.current);
            setIsSubmitting(false);
            setProgressLabel('');
            setProgressPercent(null);
            abortControllerRef.current = null;
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={handleCancel}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="p-6">
                    <div className="flex items-center justify-between mb-1">
                        <h2 className="text-lg font-semibold text-[#111111]">Add Meeting Recording</h2>
                        <button onClick={handleCancel} className="p-1 hover:bg-[#F5F5F5] rounded-full transition-colors" aria-label="Close">
                            <X className="w-5 h-5 text-[#767676]" />
                        </button>
                    </div>
                    <p className="text-sm text-[#767676] mb-4">Upload a recording or record now, then I'll turn it into a structured meeting minutes document.</p>

                    {!groqApiKey?.trim() && (
                        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
                            Set your Groq API Key (via the API Keys button in the header) before generating minutes.
                        </p>
                    )}

                    {/* Mode tabs */}
                    <div className="flex gap-2 mb-4">
                        <button
                            type="button"
                            onClick={() => setMode('upload')}
                            disabled={isSubmitting}
                            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${mode === 'upload' ? 'bg-[#0058A3] text-white border-[#0058A3]' : 'border-[#DFDFDF] text-[#484848] hover:bg-[#F5F5F5]'}`}
                        >
                            <Upload className="w-4 h-4" /> Upload recording
                        </button>
                        <button
                            type="button"
                            onClick={() => setMode('record')}
                            disabled={isSubmitting}
                            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${mode === 'record' ? 'bg-[#0058A3] text-white border-[#0058A3]' : 'border-[#DFDFDF] text-[#484848] hover:bg-[#F5F5F5]'}`}
                        >
                            <Mic className="w-4 h-4" /> Record now
                        </button>
                    </div>

                    {mode === 'upload' ? (
                        <div className="mb-4">
                            <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-[#DFDFDF] rounded-lg py-6 cursor-pointer hover:bg-[#F5F5F5] transition-colors">
                                <Upload className="w-6 h-6 text-[#767676]" />
                                <span className="text-sm text-[#484848]">
                                    {selectedFile ? selectedFile.name : 'Click to choose an audio file'}
                                </span>
                                <input
                                    type="file"
                                    accept="audio/*"
                                    className="hidden"
                                    disabled={isSubmitting}
                                    onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                                />
                            </label>
                        </div>
                    ) : (
                        <div className="mb-4 flex flex-col items-center gap-3 py-4">
                            {!recordedBlob ? (
                                <>
                                    <button
                                        type="button"
                                        onClick={isRecording ? stopRecording : startRecording}
                                        disabled={isSubmitting}
                                        className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors ${isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-[#0058A3] hover:bg-[#004F93]'}`}
                                        aria-label={isRecording ? 'Stop recording' : 'Start recording'}
                                    >
                                        {isRecording ? <Square className="w-6 h-6 text-white" fill="currentColor" /> : <Mic className="w-6 h-6 text-white" />}
                                    </button>
                                    <span className="text-sm text-[#767676]">
                                        {isRecording ? `Recording… ${formatSeconds(recordingSeconds)}` : 'Tap to start recording'}
                                    </span>
                                </>
                            ) : (
                                <div className="w-full flex flex-col items-center gap-2">
                                    <audio controls src={recordedUrl} className="w-full" />
                                    <button
                                        type="button"
                                        onClick={discardRecording}
                                        disabled={isSubmitting}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 border border-red-200 rounded-lg hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-50"
                                    >
                                        <RotateCcw className="w-3.5 h-3.5" />
                                        Discard and record again
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Runs automatically as soon as a file/recording exists, well before
                        the user reaches "Generate Meeting Minutes" — compact by design so
                        it doesn't compete with the big progress panel that phase 2
                        (transcribing + drafting) shows lower down. */}
                    {prepStatus !== 'idle' && (
                        <div className="mb-4 flex items-center gap-2 text-xs">
                            {prepStatus === 'preparing' && (
                                <>
                                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[#0058A3] shrink-0" />
                                    <span className="text-[#767676]">{prepProgressLabel || 'Preparing audio…'}</span>
                                </>
                            )}
                            {prepStatus === 'ready' && (
                                <span className="text-[#0058A3] font-medium">Audio ready — fill in the details and generate whenever you're ready.</span>
                            )}
                            {prepStatus === 'error' && (
                                <span className="text-red-500">{prepError || 'Could not prepare this recording.'}</span>
                            )}
                        </div>
                    )}

                    {/* Meta fields — mirrors the paper template's header fields */}
                    <div className="grid grid-cols-2 gap-3">
                        <div className="col-span-2">
                            <label className="text-xs font-medium text-[#767676]">Meeting title / series</label>
                            <input type="text" value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} disabled={isSubmitting}
                                placeholder="e.g. Weekly Data & Sharing Discussion"
                                className="w-full mt-1 px-3 py-2 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] text-[#111111]" />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-[#767676]">Date</label>
                            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={isSubmitting}
                                className="w-full mt-1 px-3 py-2 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] text-[#111111]" />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-[#767676]">Time</label>
                            <input type="text" value={time} onChange={(e) => setTime(e.target.value)} disabled={isSubmitting}
                                placeholder="e.g. 2pm-3pm"
                                className="w-full mt-1 px-3 py-2 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] text-[#111111]" />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-[#767676]">Note taker</label>
                            <input type="text" value={noteTaker} onChange={(e) => setNoteTaker(e.target.value)} disabled={isSubmitting}
                                className="w-full mt-1 px-3 py-2 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] text-[#111111]" />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-[#767676]">In attendance</label>
                            <input type="text" value={attendees} onChange={(e) => setAttendees(e.target.value)} disabled={isSubmitting}
                                className="w-full mt-1 px-3 py-2 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] text-[#111111]" />
                        </div>
                        <div className="col-span-2">
                            <label className="text-xs font-medium text-[#767676]">Apologies for absence</label>
                            <input type="text" value={apologies} onChange={(e) => setApologies(e.target.value)} disabled={isSubmitting}
                                className="w-full mt-1 px-3 py-2 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] text-[#111111]" />
                        </div>
                    </div>

                    {isSubmitting && (
                        <div className="mt-4 border border-[#DFDFDF] rounded-lg p-3 bg-[#F5F5F5]">
                            <div className="flex items-center justify-between gap-2 mb-2">
                                <span className="flex items-center gap-2 text-sm font-medium text-[#111111]">
                                    <Loader2 className="w-4 h-4 animate-spin text-[#0058A3] shrink-0" />
                                    {progressLabel || 'Processing…'}
                                </span>
                                <span className="text-xs text-[#767676] tabular-nums shrink-0">{formatSeconds(elapsedSeconds)}</span>
                            </div>
                            <div className="h-1.5 w-full bg-[#DFDFDF] rounded-full overflow-hidden relative">
                                {progressPercent != null ? (
                                    <div
                                        className="h-full bg-[#0058A3] rounded-full transition-all duration-500 ease-out"
                                        style={{ width: `${progressPercent}%` }}
                                    />
                                ) : (
                                    // No chunk-level progress to report yet (still uploading/preparing,
                                    // or a short recording that transcribes in a single request). A
                                    // full bar that only fades in/out reads as "finished" in a static
                                    // glance, so this instead slides a segment across — the same
                                    // "still working, no known ETA" language as a browser's indeterminate
                                    // progress bar.
                                    <div className="h-full w-2/5 bg-[#0058A3] rounded-full progress-bar-indeterminate" />
                                )}
                            </div>
                            {audioFileBytes > GROQ_CHUNKING_THRESHOLD_BYTES && (
                                <p className="mt-2 text-xs text-[#767676]">
                                    {progressPercent != null
                                        ? 'This is a long recording, so transcription runs in stages — it can take a few minutes. The percentage above updates as each stage finishes.'
                                        : 'This is a long recording — preparing it can take a little while before transcription starts.'}
                                </p>
                            )}
                        </div>
                    )}

                    {errorMessage && (
                        <div className="mt-3">
                            <p className="text-xs text-red-500">{errorMessage}</p>
                            {errorDetails && (
                                <details className="mt-1">
                                    <summary className="text-xs text-[#767676] cursor-pointer hover:text-[#111111]">Technical details</summary>
                                    <pre className="mt-1 text-xs text-[#767676] whitespace-pre-wrap bg-[#F5F5F5] rounded-lg p-2 max-h-32 overflow-y-auto">{errorDetails}</pre>
                                </details>
                            )}
                        </div>
                    )}
                </div>

                <div className="px-6 pb-6 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={handleCancel}
                        className="px-4 py-2 text-sm font-medium text-[#111111] hover:bg-[#F5F5F5] rounded-lg transition-colors"
                    >
                        Cancel
                    </button>
                    {/* Hidden while submitting rather than shown disabled: the progress
                        panel above already carries the live status, and Cancel is the
                        only action that still does anything mid-generation — there's no
                        reason to keep a second, inert button next to it. */}
                    {!isSubmitting && (
                        <button
                            type="button"
                            onClick={handleSubmit}
                            disabled={!hasAudio || !hasGroqKey || prepStatus !== 'ready'}
                            className="px-4 py-2 text-sm font-medium text-white bg-[#0058A3] hover:bg-[#004F93] rounded-lg transition-colors disabled:opacity-50"
                        >
                            {prepStatus === 'preparing' ? 'Preparing audio…' : 'Generate Meeting Minutes'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
