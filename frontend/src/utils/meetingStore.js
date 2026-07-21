// Meeting records + their audio now live entirely in the browser (IndexedDB),
// not on the backend: Render's disk is ephemeral (wiped on redeploy, and this
// service redeploys often), so anything saved server-side was disappearing on
// the next deploy or restart. The backend still does the transcription/drafting
// work (it has to — that's where the Groq/Gemini calls happen) but the result
// is cached here right after generation instead of staying server-side.
//
// localStorage (used for chat conversations elsewhere in this app) isn't an
// option for audio: its per-origin quota is typically only a few MB, and a
// single recording can be tens of MB. IndexedDB supports storing Blobs
// directly and its quota is normally a meaningful fraction of free disk space.

const DB_NAME = 'ikea-meeting-records';
const DB_VERSION = 1;
const RECORDS_STORE = 'records';
const AUDIO_STORE = 'audio';

// Matches the threshold the existing "Browser storage" bar in App.jsx uses
// for its red/over-quota color, so the two stay visually consistent even
// though they're computed independently.
export const STORAGE_WARNING_THRESHOLD = 0.85;

let dbPromise = null;

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(RECORDS_STORE)) {
                    db.createObjectStore(RECORDS_STORE, { keyPath: 'meeting_id' });
                }
                if (!db.objectStoreNames.contains(AUDIO_STORE)) {
                    db.createObjectStore(AUDIO_STORE, { keyPath: 'meeting_id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    return dbPromise;
}

function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function promisifyTransaction(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    });
}

// Saves/overwrites a full meeting record: { meeting_id, created_at,
// updated_at, audio_filename, audio_playback_filename, transcript, segments,
// meeting_data }. Rejects with a DOMException named "QuotaExceededError" if
// the browser's storage is full — callers should check error.name for that
// specifically rather than showing a generic failure message.
export async function saveMeetingRecord(record) {
    const db = await openDb();
    const tx = db.transaction(RECORDS_STORE, 'readwrite');
    tx.objectStore(RECORDS_STORE).put(record);
    await promisifyTransaction(tx);
}

// Same QuotaExceededError behavior as saveMeetingRecord — audio blobs are by
// far the largest thing stored here, so this is where a full-storage error
// actually shows up in practice.
export async function saveMeetingAudio(meetingId, blob, filename, mimeType) {
    const db = await openDb();
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).put({ meeting_id: meetingId, blob, filename, mimeType, bytes: blob.size });
    await promisifyTransaction(tx);
}

// Summary list for the Meeting Records page — mirrors the shape the old
// GET /meetings backend endpoint used to return.
export async function listMeetingRecords() {
    const db = await openDb();
    const tx = db.transaction(RECORDS_STORE, 'readonly');
    const records = await promisifyRequest(tx.objectStore(RECORDS_STORE).getAll());
    return records
        .map((r) => ({
            meeting_id: r.meeting_id,
            meeting_title: r.meeting_data?.meeting_title || '',
            date: r.meeting_data?.date || '',
            created_at: r.created_at || '',
        }))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

export async function getMeetingRecord(meetingId) {
    const db = await openDb();
    const tx = db.transaction(RECORDS_STORE, 'readonly');
    const record = await promisifyRequest(tx.objectStore(RECORDS_STORE).get(meetingId));
    return record || null;
}

// Replaces just meeting_data (agenda/notes/actions/etc — what the edit view
// changes), like the old PUT /meetings/{id} did. Returns the updated record.
export async function updateMeetingRecordData(meetingId, meetingData) {
    const existing = await getMeetingRecord(meetingId);
    if (!existing) throw new Error('Meeting record not found.');
    const updated = { ...existing, meeting_data: meetingData, updated_at: new Date().toISOString() };
    await saveMeetingRecord(updated);
    return updated;
}

export async function deleteMeetingRecord(meetingId) {
    const db = await openDb();
    const tx = db.transaction([RECORDS_STORE, AUDIO_STORE], 'readwrite');
    tx.objectStore(RECORDS_STORE).delete(meetingId);
    tx.objectStore(AUDIO_STORE).delete(meetingId);
    await promisifyTransaction(tx);
}

// Returns { meeting_id, blob, filename, mimeType, bytes } or null. Caller is
// responsible for URL.createObjectURL(blob) and revoking it when done.
export async function getMeetingAudioBlob(meetingId) {
    const db = await openDb();
    const tx = db.transaction(AUDIO_STORE, 'readonly');
    const record = await promisifyRequest(tx.objectStore(AUDIO_STORE).get(meetingId));
    return record || null;
}

// Per-meeting audio size, largest first — powers the storage-capacity warning
// banner's "here's what's taking up space, delete one of these" list. Reads
// each audio record (Blob included) via getAll(), but Blobs are lazy
// file-backed references rather than copies in JS memory, so this doesn't
// pull actual audio bytes into memory just to read .bytes off each entry.
export async function getMeetingStorageBreakdown() {
    const db = await openDb();
    const [records, audioEntries] = await Promise.all([
        listMeetingRecords(),
        (async () => {
            const tx = db.transaction(AUDIO_STORE, 'readonly');
            return promisifyRequest(tx.objectStore(AUDIO_STORE).getAll());
        })(),
    ]);
    const titleById = new Map(records.map((r) => [r.meeting_id, r.meeting_title || 'Meeting Notes']));
    return audioEntries
        .map((entry) => ({
            meeting_id: entry.meeting_id,
            title: titleById.get(entry.meeting_id) || 'Meeting Notes',
            bytes: entry.bytes || 0,
        }))
        .sort((a, b) => b.bytes - a.bytes);
}

// Thin wrapper around navigator.storage.estimate() — null in browsers/modes
// that don't support it (older browsers, some private-browsing modes) so
// callers can just hide the feature rather than handle an error.
export async function getStorageEstimate() {
    if (!navigator.storage?.estimate) return null;
    try {
        const { usage, quota } = await navigator.storage.estimate();
        if (!Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return null;
        return { usage, quota };
    } catch {
        return null;
    }
}
