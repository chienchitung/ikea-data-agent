import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Upload, X, Loader2, RotateCcw, Download, Minus } from 'lucide-react';
import { readSseStream } from '../utils/sse';
import { saveMeetingRecord, saveMeetingAudio } from '../utils/meetingStore';

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

// Meeting uploads land on Render's disk — potentially a 1GB Persistent Disk
// shared with PDFs and every other meeting record (see render.yaml) — so an
// unbounded upload could fill it on its own. 500MB comfortably covers a
// typical 45-90 minute screen-recorded meeting video at normal compression;
// anything bigger is rejected client-side before it's ever sent.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

// Render's free tier spins the backend down after inactivity; the first
// request after that can take 30-60s+ just to get a response header back,
// with nothing in between to show the user. Without a cap, fetch() just
// hangs there indefinitely (only the user's own Cancel button would ever
// resolve it) and the UI is stuck on "Uploading recording…" with no
// indication anything is happening. COLD_START_TIMEOUT_MS bounds how long we
// wait for that first response before assuming this is a cold start and
// retrying once with a clear message — chosen comfortably above normal
// network latency but well under how long a real Render cold start takes, so
// a slow-but-alive server gets one retry instead of the user staring at a
// silent spinner for a minute.
const COLD_START_TIMEOUT_MS = 25000;
const WAKEUP_RETRY_NOTICE = "The server had gone to sleep from inactivity, so this took longer than usual. It's awake now and retrying automatically.";

class ColdStartTimeoutError extends Error {}

// Races `promise` against a timer; on timeout rejects with
// ColdStartTimeoutError instead of leaving `promise` to resolve/reject
// whenever it eventually does (that original call is left running in the
// background — harmless, and it's what actually wakes Render up, so the
// retry below usually lands on an already-warm server).
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ColdStartTimeoutError('cold_start_timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Wraps fetch() so a Render cold start gets one automatic retry with clear
// status messaging instead of hanging forever. Only the header-arrival phase
// (the part `fetch()` itself resolves on) is time-boxed — SSE body streaming
// afterwards can take as long as it needs, since that's real, expected work
// (transcription, minute-drafting), not a cold-start symptom. A genuine
// network/HTTP error (rejects before the timeout) is NOT retried here — it
// propagates immediately so the existing error handling in handleSubmit
// still applies.
async function fetchWithWakeupRetry(url, options, onRetrying) {
    try {
        return await withTimeout(fetch(url, options), COLD_START_TIMEOUT_MS);
    } catch (error) {
        if (error instanceof ColdStartTimeoutError) {
            onRetrying?.();
            return fetch(url, options);
        }
        throw error;
    }
}

function formatSeconds(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Shared between buildAudioFormData (what gets uploaded) and
// handleDownloadRecording (what the user can save locally) so both agree on
// the same extension for a given recorder mimeType.
function recordingFileExtension(mimeType) {
    const isVideo = mimeType.startsWith('video/');
    const isMp4 = mimeType.includes('mp4');
    if (isVideo) return isMp4 ? 'mp4' : 'webm';
    return isMp4 ? 'm4a' : 'webm';
}

// groqApiKey is set from the Meeting Records page, not here — this modal only
// reads it (to send with the request and to disable submit when it's missing).
// isMinimized/onMinimize/onExpand let the caller keep this component mounted
// (so an in-progress recording or generation keeps running) while collapsing
// it down to a small floating pill — see the isMinimized branch in the return
// below. None of the pipeline logic above needs to know about this; it only
// changes what gets rendered.
export function MeetingRecorderModal({ apiUrl, geminiApiKey, groqApiKey, onClose, onGenerated, isMinimized, onMinimize, onExpand }) {
    const [mode, setMode] = useState('upload');
    const [selectedFile, setSelectedFile] = useState(null);
    const [recordedBlob, setRecordedBlob] = useState(null);
    const [recordedUrl, setRecordedUrl] = useState(null);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingSeconds, setRecordingSeconds] = useState(0);
    // Mic-only recording never picks up the other side of an online meeting
    // when the user is on headphones (their audio never reaches the room's
    // air, so the mic can't catch it). This opts into also capturing a
    // shared browser tab's audio (e.g. the Meet/Teams tab) and mixing it
    // with the mic — see startRecording(). Only reliably supported in
    // Chrome/Edge, and only for meetings running as a browser tab (not a
    // desktop app), so it's an opt-in, not the default.
    const [includeTabAudio, setIncludeTabAudio] = useState(false);
    const [tabAudioNotice, setTabAudioNotice] = useState('');
    const tabAudioSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
    // Only offered alongside tab-audio sharing, since it reuses the same
    // getDisplayMedia() picker/stream — recording video is opt-in and off by
    // default (bigger files, and it captures on-screen content, not just
    // audio, so it shouldn't be silently bundled into "share tab audio").
    const [includeVideo, setIncludeVideo] = useState(false);
    const [showDiscardRecordingConfirm, setShowDiscardRecordingConfirm] = useState(false);

    const [meetingTitle, setMeetingTitle] = useState('');
    const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
    const [time, setTime] = useState('');
    const [noteTaker, setNoteTaker] = useState('');
    const [attendees, setAttendees] = useState('');
    const [apologies, setApologies] = useState('');

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [progressLabel, setProgressLabel] = useState('');
    // Separate from progressLabel deliberately: the retried request's own SSE
    // stream immediately sends its own "uploading"/"preparing" progress event
    // once it succeeds, which would instantly clobber a one-shot
    // setProgressLabel(...) message before the user ever saw it (confirmed
    // via a live timing test). This banner instead persists for the rest of
    // the submission once a retry has happened, independent of whatever
    // progressLabel does afterward.
    const [wakeupNotice, setWakeupNotice] = useState('');
    // null = indeterminate (no chunk-level progress to report yet, e.g. short
    // recordings that transcribe in a single request); 0-100 = determinate.
    const [progressPercent, setProgressPercent] = useState(null);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [errorMessage, setErrorMessage] = useState('');
    const [errorDetails, setErrorDetails] = useState('');
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);

    const mediaRecorderRef = useRef(null);
    const streamRef = useRef(null);
    const displayStreamRef = useRef(null);
    const audioContextRef = useRef(null);
    const chunksRef = useRef([]);
    const timerRef = useRef(null);
    const elapsedTimerRef = useRef(null);
    const abortControllerRef = useRef(null);

    // Releases every capture resource a recording may have acquired: the mic
    // stream (always), and — only when includeTabAudio was used — the shared
    // tab's stream and the AudioContext that mixed the two together. Stopping
    // tracks on destination.stream (the mixed output) wouldn't release the
    // underlying mic/tab hardware capture; that requires stopping tracks on
    // the original streams themselves, which is why both are kept in
    // separate refs instead of only tracking the stream MediaRecorder sees.
    const releaseRecordingResources = () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        displayStreamRef.current?.getTracks().forEach((track) => track.stop());
        displayStreamRef.current = null;
        if (audioContextRef.current) {
            audioContextRef.current.close().catch(() => {});
            audioContextRef.current = null;
        }
    };

    // Fire-and-forget: ping the backend the moment this modal opens (i.e. the
    // moment the user starts interacting with meeting recording), well before
    // they've picked a file or finished recording. If Render's instance is
    // asleep, this gives it a head start waking up in the background so the
    // real upload later is more likely to land on an already-warm server.
    // Failures are silently ignored — this is purely a best-effort nudge, not
    // something the UI depends on.
    useEffect(() => {
        fetch(`${apiUrl}/health`).catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        return () => {
            clearInterval(timerRef.current);
            clearInterval(elapsedTimerRef.current);
            releaseRecordingResources();
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

    // Lets the user keep the raw recording (video especially) even if they
    // don't end up transcribing it here — reuses the same blob URL created
    // in recorder.onstop rather than allocating a new one.
    const handleDownloadRecording = () => {
        if (!recordedBlob || !recordedUrl) return;
        const link = document.createElement('a');
        link.href = recordedUrl;
        link.download = `recording-${new Date().toISOString().slice(0, 10)}.${recordingFileExtension(recordedBlob.type)}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
    };

    const startRecording = async () => {
        setErrorMessage('');
        setTabAudioNotice('');
        try {
            const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = micStream;
            chunksRef.current = [];

            let mixedAudioTrack = micStream.getAudioTracks()[0];
            let videoTrack = null;

            if (includeTabAudio && tabAudioSupported) {
                try {
                    // video: true is required for Chrome's tab picker to offer
                    // "Chrome Tab" as a source at all (it's the only source
                    // type that exposes a "Share tab audio" checkbox). The
                    // video track is kept only when includeVideo is on;
                    // otherwise it's stopped immediately since only the audio
                    // was wanted.
                    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                    // Tracked unconditionally (not just when audio pans out)
                    // so releaseRecordingResources() always stops every track
                    // this capture opened, video included.
                    displayStreamRef.current = displayStream;
                    const displayAudioTrack = displayStream.getAudioTracks()[0];
                    const displayVideoTrack = displayStream.getVideoTracks()[0];

                    if (includeVideo && displayVideoTrack) {
                        videoTrack = displayVideoTrack;
                    } else {
                        displayStream.getVideoTracks().forEach((track) => track.stop());
                    }

                    if (!displayAudioTrack) {
                        setTabAudioNotice('The shared source had no audio (pick "Chrome Tab" and check "Share tab audio" next time) — only your microphone was recorded.');
                    } else {
                        const audioContext = new AudioContext();
                        audioContextRef.current = audioContext;
                        const destination = audioContext.createMediaStreamDestination();
                        // Both sources are mono voice, so mix down to one
                        // channel explicitly -- a MediaStreamAudioDestinationNode
                        // otherwise defaults to stereo once two sources are
                        // connected to it, unlike the mic-only path (which stays
                        // mono end to end), for no benefit here.
                        destination.channelCount = 1;
                        destination.channelCountMode = 'explicit';
                        audioContext.createMediaStreamSource(micStream).connect(destination);
                        audioContext.createMediaStreamSource(new MediaStream([displayAudioTrack])).connect(destination);
                        mixedAudioTrack = destination.stream.getAudioTracks()[0];
                    }
                } catch (displayError) {
                    // Cancelling the share picker or denying permission lands
                    // here too — that's a normal choice, not a hard failure,
                    // so recording continues with the mic alone instead of
                    // aborting the whole thing.
                    console.error('Tab/system audio capture failed or was cancelled:', displayError);
                    setTabAudioNotice('Could not capture the meeting audio (permission denied or cancelled) — only your microphone was recorded.');
                }
            }

            const recordingStream = videoTrack
                ? new MediaStream([mixedAudioTrack, videoTrack])
                : new MediaStream([mixedAudioTrack]);

            const mimeCandidates = videoTrack
                ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
                : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
            const mimeType = mimeCandidates.find((candidate) => window.MediaRecorder?.isTypeSupported?.(candidate));
            const recorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream);

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunksRef.current.push(e.data);
            };
            recorder.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
                discardRecording();
                setRecordedBlob(blob);
                setRecordedUrl(URL.createObjectURL(blob));
                releaseRecordingResources();
            };

            recorder.start();
            mediaRecorderRef.current = recorder;
            setIsRecording(true);
            setRecordingSeconds(0);
            timerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
        } catch (error) {
            console.error('Microphone access failed:', error);
            setErrorMessage('Could not access the microphone. Please allow microphone permission in your browser and try again.');
            releaseRecordingResources();
        }
    };

    const stopRecording = () => {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
        clearInterval(timerRef.current);
    };

    const buildAudioFormData = () => {
        const formData = new FormData();
        if (mode === 'record' && recordedBlob) {
            // Sent under the same "audio" field name regardless of whether
            // this is an audio-only or video recording — the backend's
            // normalize_audio() already extracts the audio track from any
            // container it's handed (see prepare_meeting_audio_stream),
            // exactly like it does for an uploaded video file.
            formData.append('audio', recordedBlob, `recording.${recordingFileExtension(recordedBlob.type)}`);
        } else if (selectedFile) {
            formData.append('audio', selectedFile);
        }
        return formData;
    };

    const buildMetadataFormData = (meetingId) => {
        const formData = new FormData();
        formData.append('meeting_id', meetingId);
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

    const handleFileSelect = (file) => {
        if (file && file.size > MAX_UPLOAD_BYTES) {
            setErrorMessage(
                `This file is ${(file.size / (1024 * 1024)).toFixed(0)}MB, over the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit. Please choose a smaller file.`
            );
            setSelectedFile(null);
            return;
        }
        setErrorMessage('');
        setSelectedFile(file);
    };

    const hasAudio = mode === 'upload' ? !!selectedFile : !!recordedBlob;
    const hasGroqKey = !!(groqApiKey || '').trim();
    const audioFileBytes = mode === 'upload' ? (selectedFile?.size || 0) : (recordedBlob?.size || 0);
    const overSizeLimit = audioFileBytes > MAX_UPLOAD_BYTES;

    // Backdrop click / header X / footer Cancel all funnel through here. While
    // generation is running, a stray click (especially the backdrop, or the X
    // in the corner right next to where the progress panel sits) shouldn't be
    // able to silently kill an in-flight transcription — so this only asks
    // for confirmation at that point instead of cancelling immediately.
    //
    // A finished-but-unsubmitted recording gets the same treatment: nothing
    // is written to IndexedDB until generation actually completes (see
    // handleSubmit's "Saving to your browser…" step), so the recording only
    // ever exists as an in-memory blob up to that point — closing without
    // transcribing discards it for good, which is worth a confirmation,
    // especially for video (bigger, more effort to redo than a quick voice
    // memo). Only checked for 'record' mode: an unsubmitted upload isn't at
    // risk the same way, since the original file is still sitting wherever
    // the user picked it from.
    //
    // This dialog can't catch the browser tab/window itself being closed —
    // only an in-app "beforeunload" prompt could, and this doesn't add one.
    const handleCancel = () => {
        if (isSubmitting) {
            setShowCancelConfirm(true);
            return;
        }
        if (mode === 'record' && recordedBlob) {
            setShowDiscardRecordingConfirm(true);
            return;
        }
        onClose();
    };

    // The actual cancel, only reachable via the confirmation dialog's
    // destructive button. Aborting resolves readSseStream's await with an
    // AbortError, which the catch block below already treats as a silent,
    // expected cancellation.
    const confirmCancelGeneration = () => {
        setShowCancelConfirm(false);
        abortControllerRef.current?.abort();
        onClose();
    };

    // Only reachable via the discard-recording confirmation dialog. Doesn't
    // need to manually revoke the blob URL or clear state itself — closing
    // unmounts this modal, and the cleanup effect above already handles that.
    const confirmDiscardRecordingAndClose = () => {
        setShowDiscardRecordingConfirm(false);
        onClose();
    };

    // One click runs the whole pipeline — upload+prepare audio, then
    // transcribe+draft — under a single continuous progress panel. This used
    // to be split into an automatic "prepare while you fill in the form"
    // phase plus a separate click, on the theory that prep would usually
    // finish before the user reached the button. In practice it just added a
    // second, separate-feeling wait after the first one instead of shortening
    // anything, so it's back to one click, one wait, one thing to watch.
    const handleSubmit = async () => {
        if (!hasAudio || !hasGroqKey || isSubmitting || overSizeLimit) return;
        setIsSubmitting(true);
        setErrorMessage('');
        setErrorDetails('');
        setWakeupNotice('');
        setProgressLabel('Uploading recording…');
        setProgressPercent(null);
        setElapsedSeconds(0);
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);

        const controller = new AbortController();
        abortControllerRef.current = controller;

        const onSseEvent = (event, data, onFinal, onError) => {
            if (event === 'progress') {
                const percent = typeof data?.percent === 'number' ? data.percent : null;
                const baseLabel = PROGRESS_LABELS[data?.phase] || data?.label || 'Processing…';
                setProgressLabel(percent != null ? `${baseLabel} ${percent}%` : baseLabel);
                setProgressPercent(percent);
            } else if (event === 'final') {
                onFinal(data);
            } else if (event === 'error') {
                onError(data);
            }
        };

        // meeting_id is only assigned once prepare-audio actually succeeds —
        // used in the catch block below to clean up a meeting that finished
        // preparing but never made it through generate (e.g. cancelled or
        // failed mid-transcription), so it doesn't linger server-side
        // attached to nothing.
        let meetingId = null;

        try {
            // The prepare-audio request carries the actual file — up to
            // MAX_UPLOAD_BYTES (500MB) — so racing *that* fetch() against
            // COLD_START_TIMEOUT_MS the way fetchWithWakeupRetry normally
            // does would misread a large file's genuine upload time (which
            // can legitimately run into minutes on a slow connection, video
            // files especially) as a cold start and retry the whole upload
            // from scratch. Cold-start detection belongs on a fast, bodyless
            // request instead: confirm the server is awake with a /health
            // check first (already time-boxed and retried by
            // fetchWithWakeupRetry), then send the real upload as a plain,
            // untimed fetch() — however long it takes once the server is
            // confirmed awake is real transfer time, not a cold-start symptom.
            await fetchWithWakeupRetry(
                `${apiUrl}/health`,
                { signal: controller.signal },
                () => setWakeupNotice(WAKEUP_RETRY_NOTICE),
            );

            const prepResponse = await fetch(
                `${apiUrl}/meetings/prepare-audio/stream`,
                { method: 'POST', body: buildAudioFormData(), signal: controller.signal },
            );
            if (!prepResponse.ok) {
                const data = await prepResponse.json().catch(() => null);
                throw new Error(data?.detail?.message || data?.message || `Request failed with status ${prepResponse.status}`);
            }

            let prepFinal = null;
            let prepError = null;
            await readSseStream(prepResponse, (event, data) => onSseEvent(event, data, (d) => { prepFinal = d; }, (d) => { prepError = d; }));
            if (prepError) throw new Error(prepError.message || 'Could not prepare this recording.');
            if (!prepFinal?.meeting_id) throw new Error('Audio preparation ended without a result.');
            meetingId = prepFinal.meeting_id;

            const genResponse = await fetchWithWakeupRetry(
                `${apiUrl}/meetings/generate/stream`,
                { method: 'POST', body: buildMetadataFormData(meetingId), signal: controller.signal },
                () => setWakeupNotice(WAKEUP_RETRY_NOTICE),
            );
            if (!genResponse.ok) {
                const data = await genResponse.json().catch(() => null);
                const failure = new Error(data?.detail?.message || data?.message || `Request failed with status ${genResponse.status}`);
                failure.details = data?.detail?.details || data?.details;
                throw failure;
            }

            let finalPayload = null;
            let errorPayload = null;
            await readSseStream(genResponse, (event, data) => onSseEvent(event, data, (d) => { finalPayload = d; }, (d) => { errorPayload = d; }));

            if (errorPayload) {
                const failure = new Error(errorPayload.message || 'Meeting minutes generation failed.');
                failure.details = errorPayload.details;
                throw failure;
            }
            if (!finalPayload) {
                throw new Error('Stream ended before a final response was returned.');
            }

            // The backend only holds this generation transiently — persistence
            // is the browser's job now (see meetingStore.js). Pull the audio
            // down once and cache everything locally before telling the
            // backend it can drop its copy.
            setProgressLabel('Saving to your browser…');
            setProgressPercent(null);
            try {
                const audioResponse = await fetch(`${apiUrl}/meetings/${finalPayload.meeting_id}/audio`, {
                    signal: controller.signal,
                });
                if (!audioResponse.ok) throw new Error(`Could not download the recording to save it locally (status ${audioResponse.status}).`);
                const audioBlob = await audioResponse.blob();

                await saveMeetingAudio(
                    finalPayload.meeting_id, audioBlob,
                    finalPayload.audio_playback_filename, audioBlob.type,
                );
                await saveMeetingRecord({
                    meeting_id: finalPayload.meeting_id,
                    created_at: finalPayload.created_at,
                    audio_filename: finalPayload.audio_filename,
                    audio_playback_filename: finalPayload.audio_playback_filename,
                    transcript: finalPayload.transcript,
                    segments: finalPayload.segments,
                    meeting_data: finalPayload.minutes,
                });
            } catch (saveError) {
                if (saveError.name === 'AbortError') return;
                console.error('Failed to save meeting record locally:', saveError);
                const failure = saveError.name === 'QuotaExceededError'
                    ? new Error("Your browser's storage is full, so this meeting couldn't be saved. Delete some older meeting recordings (from the Meeting Records list) to free up space, then try again.")
                    : new Error('The meeting was transcribed, but saving it to your browser failed. It has not been kept — please try again.');
                throw failure;
            }

            // Backend cleanup is best-effort and shouldn't block the user from
            // seeing their result — this meeting_id is already safely cached
            // locally at this point regardless of whether the delete succeeds.
            fetch(`${apiUrl}/meetings/${finalPayload.meeting_id}`, { method: 'DELETE' }).catch(() => {});
            onGenerated(finalPayload);
        } catch (error) {
            if (error.name === 'AbortError') {
                // Prepare-audio finished (we have a meeting_id) but generate was
                // cancelled or failed before ever saving a record — clean up the
                // now-orphaned server-side prep rather than leaving it attached
                // to nothing.
                if (meetingId) fetch(`${apiUrl}/meetings/${meetingId}`, { method: 'DELETE' }).catch(() => {});
                return;
            }
            console.error('Meeting generation failed:', error);
            if (meetingId) fetch(`${apiUrl}/meetings/${meetingId}`, { method: 'DELETE' }).catch(() => {});
            setErrorMessage(error.message || 'Something went wrong while generating meeting minutes.');
            setErrorDetails(typeof error.details === 'string' ? error.details : (error.details ? JSON.stringify(error.details) : ''));
        } finally {
            clearInterval(elapsedTimerRef.current);
            setIsSubmitting(false);
            setProgressLabel('');
            setProgressPercent(null);
            setShowCancelConfirm(false);
            abortControllerRef.current = null;
        }
    };

    // Collapsed state: keeps recording/uploading/generating running in the
    // background (this component never unmounts) while getting out of the
    // way so the user can go do something else, e.g. keep chatting. Only a
    // click-to-expand affordance here on purpose — Cancel/Discard stay
    // exclusive to the full modal so they aren't duplicated in two places.
    if (isMinimized) {
        return (
            <button
                type="button"
                onClick={onExpand}
                className="fixed bottom-4 right-4 z-50 flex items-center gap-3 bg-white border border-[#DFDFDF] shadow-lg rounded-full pl-4 pr-5 py-3 hover:shadow-xl transition-shadow"
                aria-label="Expand meeting recorder"
            >
                {isRecording ? (
                    <>
                        <span className="relative flex h-3 w-3 shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                        </span>
                        <span className="text-sm font-medium text-[#111111]">Recording… {formatSeconds(recordingSeconds)}</span>
                    </>
                ) : isSubmitting ? (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin text-[#0058A3] shrink-0" />
                        <span className="text-sm font-medium text-[#111111]">{progressLabel || 'Processing…'}</span>
                        {progressPercent != null && (
                            <span className="text-xs text-[#767676] tabular-nums">{progressPercent}%</span>
                        )}
                    </>
                ) : (
                    <>
                        <Mic className="w-4 h-4 text-[#0058A3] shrink-0" />
                        <span className="text-sm font-medium text-[#111111]">Meeting recorder</span>
                    </>
                )}
                <span className="text-xs text-[#0058A3] font-medium">Expand</span>
            </button>
        );
    }

    return (
        <>
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={handleCancel}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="meeting-recorder-heading"
                className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-6">
                    <div className="flex items-center justify-between mb-1">
                        <h2 id="meeting-recorder-heading" className="text-lg font-semibold text-[#111111]">Add Meeting Recording</h2>
                        <div className="flex items-center gap-1">
                            <button onClick={onMinimize} className="p-1 hover:bg-[#F5F5F5] rounded-full transition-colors" aria-label="Minimize">
                                <Minus className="w-5 h-5 text-[#767676]" />
                            </button>
                            <button onClick={handleCancel} className="p-1 hover:bg-[#F5F5F5] rounded-full transition-colors" aria-label="Close">
                                <X className="w-5 h-5 text-[#767676]" />
                            </button>
                        </div>
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
                            <label className="flex flex-col items-center justify-center gap-1 border-2 border-dashed border-[#DFDFDF] rounded-lg py-6 cursor-pointer hover:bg-[#F5F5F5] transition-colors">
                                <Upload className="w-6 h-6 text-[#767676] mb-1" />
                                <span className="text-sm text-[#484848]">
                                    {selectedFile ? selectedFile.name : 'Click to choose an audio or video file'}
                                </span>
                                <span className="text-xs text-[#767676]">
                                    Video works too, up to {MAX_UPLOAD_BYTES / (1024 * 1024)}MB
                                </span>
                                <input
                                    type="file"
                                    accept="audio/*,video/*"
                                    className="hidden"
                                    disabled={isSubmitting}
                                    onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
                                />
                            </label>
                        </div>
                    ) : (
                        <div className="mb-4 flex flex-col items-center gap-3 py-4">
                            {!recordedBlob ? (
                                <>
                                    {!isRecording && (
                                        <div className="w-full max-w-sm text-left">
                                            <label className="flex items-start gap-2 text-xs text-[#484848] cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={includeTabAudio}
                                                    onChange={(e) => {
                                                        setIncludeTabAudio(e.target.checked);
                                                        // Video capture rides on the same shared-tab
                                                        // stream, so it stops making sense once tab
                                                        // sharing itself is turned off.
                                                        if (!e.target.checked) setIncludeVideo(false);
                                                    }}
                                                    disabled={!tabAudioSupported}
                                                    className="mt-0.5 rounded border-[#DFDFDF] shrink-0"
                                                />
                                                <span>
                                                    Also capture an online meeting's audio (share a browser tab)
                                                    <span className="block mt-0.5 text-[11px] text-[#767676]">
                                                        {tabAudioSupported
                                                            ? 'Catches the other side too, useful on headphones. Chrome/Edge only.'
                                                            : 'Not supported in this browser — try Chrome or Edge.'}
                                                    </span>
                                                </span>
                                            </label>
                                            {includeTabAudio && tabAudioSupported && (
                                                <label className="mt-2 flex items-center gap-2 text-xs text-[#484848] cursor-pointer">
                                                    <input
                                                        type="checkbox"
                                                        checked={includeVideo}
                                                        onChange={(e) => setIncludeVideo(e.target.checked)}
                                                        className="rounded border-[#DFDFDF] shrink-0"
                                                    />
                                                    Also record the shared tab's video
                                                </label>
                                            )}
                                        </div>
                                    )}
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
                                    {tabAudioNotice && (
                                        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 w-full">
                                            {tabAudioNotice}
                                        </p>
                                    )}
                                    {recordedBlob.type.startsWith('video/') ? (
                                        <video controls src={recordedUrl} className="w-full rounded-lg" />
                                    ) : (
                                        <audio controls src={recordedUrl} className="w-full" />
                                    )}
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={handleDownloadRecording}
                                            disabled={isSubmitting}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0058A3] border border-[#0058A3]/30 rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-50"
                                        >
                                            <Download className="w-3.5 h-3.5" />
                                            Download recording
                                        </button>
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
                                        ? 'This is a long recording, so this runs in stages — it can take a few minutes. The percentage above updates as each stage finishes.'
                                        : 'This is a long recording — it can take a little while before the percentage above starts moving.'}
                                </p>
                            )}
                            {wakeupNotice && (
                                <p className="mt-2 text-xs text-[#0058A3] bg-blue-50 border border-blue-100 rounded-lg px-2 py-1.5">
                                    {wakeupNotice}
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
                            disabled={!hasAudio || !hasGroqKey || overSizeLimit}
                            className="px-4 py-2 text-sm font-medium text-white bg-[#0058A3] hover:bg-[#004F93] rounded-lg transition-colors disabled:opacity-50"
                        >
                            Generate Meeting Minutes
                        </button>
                    )}
                </div>
            </div>
        </div>

        {/* Confirm-before-cancel: generation is a few minutes of Groq/Gemini
            work that a stray click shouldn't be able to throw away silently. */}
        {showCancelConfirm && (
            <div
                className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4"
                onClick={() => setShowCancelConfirm(false)}
            >
                <div
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="cancel-generation-heading"
                    aria-describedby="cancel-generation-description"
                    className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key === 'Escape') setShowCancelConfirm(false); }}
                >
                    <h3 id="cancel-generation-heading" className="text-base font-semibold text-[#111111] mb-1">Stop generating this meeting record?</h3>
                    <p id="cancel-generation-description" className="text-sm text-[#767676] mb-5">
                        {progressLabel || 'Generation'} is still in progress. If you cancel now, the transcript and
                        meeting minutes generated so far won't be kept.
                    </p>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            autoFocus
                            onClick={() => setShowCancelConfirm(false)}
                            className="px-4 py-2 text-sm font-medium text-[#111111] hover:bg-[#F5F5F5] rounded-lg transition-colors"
                        >
                            Keep generating
                        </button>
                        <button
                            type="button"
                            onClick={confirmCancelGeneration}
                            className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
                        >
                            Stop and discard
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* Confirm-before-discard: closing without transcribing is the only
            way this recording is lost — nothing is saved to the browser
            until generation finishes (see handleSubmit), so this is the
            last chance to keep it via "Download recording" instead. */}
        {showDiscardRecordingConfirm && (
            <div
                className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4"
                onClick={() => setShowDiscardRecordingConfirm(false)}
            >
                <div
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="discard-recording-heading"
                    aria-describedby="discard-recording-description"
                    className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key === 'Escape') setShowDiscardRecordingConfirm(false); }}
                >
                    <h3 id="discard-recording-heading" className="text-base font-semibold text-[#111111] mb-1">Discard this recording?</h3>
                    <p id="discard-recording-description" className="text-sm text-[#767676] mb-5">
                        You haven't generated meeting minutes from it. Closing now discards it for good —
                        it isn't saved anywhere in your browser unless you transcribe it or download it first.
                    </p>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            autoFocus
                            onClick={() => setShowDiscardRecordingConfirm(false)}
                            className="px-4 py-2 text-sm font-medium text-[#111111] hover:bg-[#F5F5F5] rounded-lg transition-colors"
                        >
                            Keep recording
                        </button>
                        <button
                            type="button"
                            onClick={confirmDiscardRecordingAndClose}
                            className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
                        >
                            Discard and close
                        </button>
                    </div>
                </div>
            </div>
        )}
        </>
    );
}
