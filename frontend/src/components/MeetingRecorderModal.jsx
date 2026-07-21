import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Upload, X, Loader2, RotateCcw } from 'lucide-react';
import { readSseStream } from '../utils/sse';

const PROGRESS_LABELS = {
    uploading_audio: 'Uploading recording…',
    normalizing_audio: 'Preparing audio…',
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

    const mediaRecorderRef = useRef(null);
    const streamRef = useRef(null);
    const chunksRef = useRef([]);
    const timerRef = useRef(null);
    const elapsedTimerRef = useRef(null);
    const abortControllerRef = useRef(null);

    useEffect(() => {
        return () => {
            clearInterval(timerRef.current);
            clearInterval(elapsedTimerRef.current);
            streamRef.current?.getTracks().forEach((track) => track.stop());
            if (recordedUrl) URL.revokeObjectURL(recordedUrl);
            abortControllerRef.current?.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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

    const buildFormData = () => {
        const formData = new FormData();
        if (mode === 'record' && recordedBlob) {
            const ext = recordedBlob.type.includes('mp4') ? 'm4a' : 'webm';
            formData.append('audio', recordedBlob, `recording.${ext}`);
        } else if (selectedFile) {
            formData.append('audio', selectedFile);
        }
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

    const handleSubmit = async () => {
        if (!hasAudio || !hasGroqKey || isSubmitting) return;
        setIsSubmitting(true);
        setErrorMessage('');
        setErrorDetails('');
        setProgressLabel('Uploading recording…');
        setProgressPercent(null);
        setElapsedSeconds(0);
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);

        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
            const response = await fetch(`${apiUrl}/meetings/generate/stream`, {
                method: 'POST',
                body: buildFormData(),
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
                    setProgressLabel(
                        percent != null
                            ? `Transcribing audio… ${percent}%`
                            : (PROGRESS_LABELS[data?.phase] || data?.label || 'Processing…')
                    );
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !isSubmitting && onClose()}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="p-6">
                    <div className="flex items-center justify-between mb-1">
                        <h2 className="text-lg font-semibold text-[#111111]">Add Meeting Recording</h2>
                        <button onClick={() => !isSubmitting && onClose()} className="p-1 hover:bg-[#F5F5F5] rounded-full transition-colors" aria-label="Close">
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
                        onClick={() => !isSubmitting && onClose()}
                        disabled={isSubmitting}
                        className="px-4 py-2 text-sm font-medium text-[#111111] hover:bg-[#F5F5F5] rounded-lg transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={!hasAudio || !hasGroqKey || isSubmitting}
                        className="px-4 py-2 text-sm font-medium text-white bg-[#0058A3] hover:bg-[#004F93] rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
                    >
                        {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                        {isSubmitting ? (progressLabel || 'Processing…') : 'Generate Meeting Minutes'}
                    </button>
                </div>
            </div>
        </div>
    );
}
