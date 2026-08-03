import { describe, it, expect } from 'vitest';
import {
    formatMeetingRecordForContext,
    saveMeetingRecord,
    getMeetingRecord,
    listMeetingRecords,
    updateMeetingRecordData,
    deleteMeetingRecord,
    saveMeetingAudio,
    getMeetingAudioBlob,
} from './meetingStore';

describe('formatMeetingRecordForContext', () => {
    it('formats a full record into a readable text block', () => {
        const record = {
            meeting_id: 'm1',
            meeting_data: {
                meeting_title: 'Quarterly Roadmap Sync',
                date: '2026-07-15',
                time: '14:00',
                note_taker: 'Jane',
                attendees: 'Alice, Bob',
                apologies: 'Carol',
                executive_summary: 'Discussed Q3 priorities.',
                agenda: [{ no: 1, item: 'Review Q3 goals', owner: 'Alice' }],
                notes: ['Budget approved.'],
                actions_review: [{ no: 1, item: 'Finalize API doc', assigned_to: 'Bob', deadline: '2026-08-01' }],
            },
        };
        const text = formatMeetingRecordForContext(record);

        expect(text).toContain('會議標題：Quarterly Roadmap Sync');
        expect(text).toContain('日期／時間：2026-07-15 14:00');
        expect(text).toContain('記錄人：Jane');
        expect(text).toContain('出席：Alice, Bob');
        expect(text).toContain('請假：Carol');
        expect(text).toContain('摘要：');
        expect(text).toContain('Discussed Q3 priorities.');
        expect(text).toContain('議程：');
        expect(text).toContain('1. Review Q3 goals，負責人：Alice');
        expect(text).toContain('備註：');
        expect(text).toContain('- Budget approved.');
        expect(text).toContain('待辦事項：');
        expect(text).toContain('1. Finalize API doc，負責人：Bob，期限：2026-08-01');

        // The raw transcript is never part of this output — see the "why"
        // comment on formatMeetingRecordForContext in meetingStore.js.
        expect(text).not.toContain('transcript');
    });

    it('omits empty sections instead of printing empty headers', () => {
        const record = { meeting_id: 'm2', meeting_data: { meeting_title: 'Bare Meeting' } };
        const text = formatMeetingRecordForContext(record);

        expect(text).toContain('會議標題：Bare Meeting');
        expect(text).not.toContain('日期／時間：');
        expect(text).not.toContain('摘要：');
        expect(text).not.toContain('議程：');
        expect(text).not.toContain('備註：');
        expect(text).not.toContain('待辦事項：');
    });

    it('falls back to a default title when meeting_data is missing entirely', () => {
        const text = formatMeetingRecordForContext({ meeting_id: 'm3' });
        expect(text).toContain('會議標題：Meeting Notes');
    });

    it('tolerates malformed agenda/action entries without throwing', () => {
        const record = {
            meeting_id: 'm4',
            meeting_data: {
                meeting_title: 'Messy Meeting',
                agenda: [null, {}, { item: 'Valid item' }],
                actions_review: [{ item: 'No assignee, no deadline' }],
            },
        };
        expect(() => formatMeetingRecordForContext(record)).not.toThrow();
        const text = formatMeetingRecordForContext(record);
        expect(text).toContain('Valid item');
        expect(text).toContain('1. No assignee, no deadline');
    });
});

describe('meetingStore IndexedDB round trip', () => {
    it('saves and retrieves a full meeting record', async () => {
        const record = {
            meeting_id: 'idb-1',
            created_at: '2026-07-01T00:00:00.000Z',
            transcript: 'raw transcript text',
            meeting_data: { meeting_title: 'IDB Test Meeting', date: '2026-07-01' },
        };
        await saveMeetingRecord(record);
        const loaded = await getMeetingRecord('idb-1');
        expect(loaded).toEqual(record);
    });

    it('returns null for a meeting that does not exist', async () => {
        const loaded = await getMeetingRecord('does-not-exist');
        expect(loaded).toBeNull();
    });

    it('lists saved records as summaries sorted newest-first', async () => {
        await saveMeetingRecord({
            meeting_id: 'idb-older',
            created_at: '2026-07-01T00:00:00.000Z',
            transcript: 'older transcript',
            meeting_data: { meeting_title: 'Older Meeting', date: '2026-07-01' },
        });
        await saveMeetingRecord({
            meeting_id: 'idb-newer',
            created_at: '2026-07-10T00:00:00.000Z',
            transcript: 'newer transcript',
            meeting_data: { meeting_title: 'Newer Meeting', date: '2026-07-10' },
        });

        const summaries = await listMeetingRecords();
        const older = summaries.find((s) => s.meeting_id === 'idb-older');
        const newer = summaries.find((s) => s.meeting_id === 'idb-newer');
        expect(older).toMatchObject({ meeting_title: 'Older Meeting', date: '2026-07-01', transcript: 'older transcript' });
        expect(newer).toMatchObject({ meeting_title: 'Newer Meeting', date: '2026-07-10', transcript: 'newer transcript' });
        expect(summaries.indexOf(newer)).toBeLessThan(summaries.indexOf(older));
    });

    it('updateMeetingRecordData replaces meeting_data and bumps updated_at', async () => {
        await saveMeetingRecord({
            meeting_id: 'idb-update',
            created_at: '2026-07-01T00:00:00.000Z',
            transcript: '',
            meeting_data: { meeting_title: 'Before Edit' },
        });
        const updated = await updateMeetingRecordData('idb-update', { meeting_title: 'After Edit' });
        expect(updated.meeting_data.meeting_title).toBe('After Edit');
        expect(updated.updated_at).toBeTruthy();

        const reloaded = await getMeetingRecord('idb-update');
        expect(reloaded.meeting_data.meeting_title).toBe('After Edit');
    });

    it('updateMeetingRecordData throws for a meeting that does not exist', async () => {
        await expect(updateMeetingRecordData('missing-id', {})).rejects.toThrow('Meeting record not found.');
    });

    it('deleteMeetingRecord removes both the record and its audio', async () => {
        await saveMeetingRecord({
            meeting_id: 'idb-delete',
            created_at: '2026-07-01T00:00:00.000Z',
            transcript: '',
            meeting_data: { meeting_title: 'To Delete' },
        });
        await saveMeetingAudio('idb-delete', new Blob(['fake audio']), 'audio.mp3', 'audio/mpeg');

        await deleteMeetingRecord('idb-delete');

        expect(await getMeetingRecord('idb-delete')).toBeNull();
        expect(await getMeetingAudioBlob('idb-delete')).toBeNull();
    });
});
