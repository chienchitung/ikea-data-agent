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

import { openDb, promisifyRequest, promisifyTransaction, RECORDS_STORE, AUDIO_STORE } from './db';

// Matches the threshold the existing "Browser storage" bar in App.jsx uses
// for its red/over-quota color, so the two stay visually consistent even
// though they're computed independently.
export const STORAGE_WARNING_THRESHOLD = 0.85;

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
// GET /meetings backend endpoint used to return, plus `transcript` so the
// list view can search over it without a second read per meeting: getAll()
// below already pulls the full record (transcript included) off disk, so
// carrying it through here is free.
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
            transcript: r.transcript || '',
        }))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

export async function getMeetingRecord(meetingId) {
    const db = await openDb();
    const tx = db.transaction(RECORDS_STORE, 'readonly');
    const record = await promisifyRequest(tx.objectStore(RECORDS_STORE).get(meetingId));
    return record || null;
}

// Formats a full meeting record (as returned by getMeetingRecord) into a
// plain-text block for handing to the chat LLM as reference material — the
// organized minutes (summary/agenda/notes/action items), not the raw
// transcript, since that's what "add to conversation context" is meant to
// send (the transcript can be tens of thousands of words for a long
// recording, far too much to put in every prompt).
export function formatMeetingRecordForContext(record) {
    const data = record?.meeting_data || {};
    const lines = [];

    lines.push(`會議標題：${data.meeting_title || 'Meeting Notes'}`);
    const when = [data.date, data.time].filter(Boolean).join(' ');
    if (when) lines.push(`日期／時間：${when}`);
    if (data.note_taker) lines.push(`記錄人：${data.note_taker}`);
    if (data.attendees) lines.push(`出席：${data.attendees}`);
    if (data.apologies) lines.push(`請假：${data.apologies}`);

    if (data.executive_summary) {
        lines.push('', '摘要：', data.executive_summary);
    }

    if (Array.isArray(data.agenda) && data.agenda.length) {
        lines.push('', '議程：');
        data.agenda.forEach((item, idx) => {
            const parts = [item?.item || ''];
            if (item?.owner) parts.push(`負責人：${item.owner}`);
            lines.push(`${idx + 1}. ${parts.filter(Boolean).join('，')}`);
        });
    }

    if (Array.isArray(data.notes) && data.notes.length) {
        lines.push('', '備註：');
        data.notes.forEach((note) => lines.push(`- ${note}`));
    }

    if (Array.isArray(data.actions_review) && data.actions_review.length) {
        lines.push('', '待辦事項：');
        data.actions_review.forEach((action, idx) => {
            const parts = [action?.item || ''];
            if (action?.assigned_to) parts.push(`負責人：${action.assigned_to}`);
            if (action?.deadline) parts.push(`期限：${action.deadline}`);
            lines.push(`${action?.no ?? idx + 1}. ${parts.filter(Boolean).join('，')}`);
        });
    }

    return lines.join('\n').trim();
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

// ── Export / import (backup) ─────────────────────────────────
//
// Records live only in this one browser's IndexedDB now — no server copy to
// fall back on — so moving to a new device or recovering from a cleared
// browser profile needs an explicit backup/restore path. Packaged as a
// single JSON file (audio embedded as base64) rather than a .zip so this
// doesn't need a zip library as a dependency; JSON.parse on a file with a
// handful of meetings' worth of base64 audio is well within what a browser
// handles fine synchronously.

const BACKUP_FORMAT = 'ikea-data-agent-meeting-backup';
const BACKUP_VERSION = 1;

async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    // String.fromCharCode(...bytes) on a large typed array can blow the call
    // stack (it spreads into individual arguments), so this goes chunk by
    // chunk instead — matters here since a chunk-sized meeting recording is
    // exactly the kind of file this function handles.
    const CHUNK_SIZE = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
    }
    return btoa(binary);
}

function base64ToBlob(base64, mimeType) {
    const byteChars = atob(base64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
}

// Returns a downloadable Blob. Pass meetingIds to export a subset (e.g. the
// current selection); omit/pass null to export everything.
export async function exportMeetingRecords(meetingIds = null) {
    const summaries = await listMeetingRecords();
    const idsToExport = meetingIds && meetingIds.length ? meetingIds : summaries.map((s) => s.meeting_id);

    const meetings = [];
    for (const meetingId of idsToExport) {
        const record = await getMeetingRecord(meetingId);
        if (!record) continue;
        const audio = await getMeetingAudioBlob(meetingId);
        meetings.push({
            ...record,
            audio: audio ? {
                filename: audio.filename,
                mimeType: audio.mimeType,
                base64: await blobToBase64(audio.blob),
            } : null,
        });
    }

    const payload = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        meetings,
    };
    return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

// Imports a backup produced by exportMeetingRecords(). Existing records with
// the same meeting_id are overwritten (this is a restore, not a merge).
// onProgress(imported, total) is called after each meeting so callers can
// show progress for a large backup. Returns the number of meetings imported.
export async function importMeetingRecords(file, onProgress) {
    const text = await file.text();
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new Error('This file is not a valid backup (not JSON).');
    }
    if (payload?.format !== BACKUP_FORMAT || !Array.isArray(payload.meetings)) {
        throw new Error('This file is not a recognized meeting-records backup.');
    }

    let imported = 0;
    for (const entry of payload.meetings) {
        const { audio, ...record } = entry;
        if (!record.meeting_id) continue;
        await saveMeetingRecord(record);
        if (audio?.base64) {
            await saveMeetingAudio(record.meeting_id, base64ToBlob(audio.base64, audio.mimeType), audio.filename, audio.mimeType);
        }
        imported += 1;
        onProgress?.(imported, payload.meetings.length);
    }
    return imported;
}
