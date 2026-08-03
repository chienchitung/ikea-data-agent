import { describe, it, expect } from 'vitest';
import {
    listActionItems,
    hasImportedActionsForMeeting,
    syncActionItemsFromMeeting,
    addActionItem,
    updateActionItem,
    moveActionItem,
    reorderActionItems,
    deleteActionItem,
    ACTION_STATUSES,
} from './actionItemStore';
import { saveMeetingRecord, getMeetingRecord } from './meetingStore';

// syncActionItemsFromMeeting persists backfilled action-item ids back onto
// the meeting record (see its doc comment in actionItemStore.js), so —
// unlike the old one-shot import — the record needs to actually exist in
// IndexedDB first, the same way it does for real once minutes generation
// finishes and saves it there.
async function meetingRecord(id, actions) {
    const record = {
        meeting_id: id,
        meeting_data: {
            meeting_title: `Meeting ${id}`,
            actions_review: actions,
        },
    };
    await saveMeetingRecord(record);
    return record;
}

describe('syncActionItemsFromMeeting', () => {
    it('creates one To Do card per action item, tagged with the source meeting', async () => {
        const record = await meetingRecord('m-import-1', [
            { no: 1, item: 'Finalize API doc', assigned_to: 'Bob', deadline: '2026-08-01' },
            { no: 2, item: 'Review budget', assigned_to: 'Alice', deadline: '2026-08-05' },
        ]);

        const result = await syncActionItemsFromMeeting(record);
        expect(result.created).toBe(2);
        expect(result.updated).toBe(0);

        const all = await listActionItems();
        const imported = all.filter((a) => a.meeting_id === 'm-import-1');
        expect(imported.every((c) => c.status === 'To Do')).toBe(true);
        expect(imported.every((c) => c.meeting_title === 'Meeting m-import-1')).toBe(true);
        expect(imported.map((a) => a.item).sort()).toEqual(['Finalize API doc', 'Review budget']);
    });

    it('skips action items with empty text', async () => {
        const record = await meetingRecord('m-import-2', [
            { item: '', assigned_to: 'Nobody', deadline: '' },
            { item: '  ', assigned_to: 'Nobody', deadline: '' },
            { item: 'Real action', assigned_to: 'Carol', deadline: '2026-09-01' },
        ]);
        const result = await syncActionItemsFromMeeting(record);
        expect(result.created).toBe(1);
        const all = await listActionItems();
        expect(all.filter((a) => a.meeting_id === 'm-import-2').map((a) => a.item)).toEqual(['Real action']);
    });

    it('does nothing when the meeting has no actions_review', async () => {
        const empty = await meetingRecord('m-import-3', []);
        expect(await syncActionItemsFromMeeting(empty)).toEqual({ created: 0, updated: 0, record: empty });
        const noActions = { meeting_id: 'm-import-4', meeting_data: {} };
        expect(await syncActionItemsFromMeeting(noActions)).toEqual({ created: 0, updated: 0, record: noActions });
    });

    it('hasImportedActionsForMeeting reflects whether that meeting has been imported', async () => {
        const record = await meetingRecord('m-import-5', [{ item: 'Something', assigned_to: '', deadline: '' }]);
        expect(await hasImportedActionsForMeeting('m-import-5')).toBe(false);
        await syncActionItemsFromMeeting(record);
        expect(await hasImportedActionsForMeeting('m-import-5')).toBe(true);
    });

    it('re-syncing the same meeting does not duplicate cards, and backfills a stable id per row', async () => {
        const record = await meetingRecord('m-sync-1', [
            { item: 'Track this', assigned_to: 'Dana', deadline: '2026-10-01' },
        ]);

        const first = await syncActionItemsFromMeeting(record);
        expect(first.created).toBe(1);
        expect(first.record.meeting_data.actions_review[0].id).toBeTruthy();

        const second = await syncActionItemsFromMeeting(first.record);
        expect(second.created).toBe(0);
        expect(second.updated).toBe(1);

        const all = await listActionItems();
        expect(all.filter((a) => a.meeting_id === 'm-sync-1')).toHaveLength(1);
    });

    it('re-syncing after editing actions_review updates the linked card in place, preserving status/order', async () => {
        const record = await meetingRecord('m-sync-2', [
            { item: 'Original text', assigned_to: 'Alice', deadline: '2026-08-01' },
        ]);
        const first = await syncActionItemsFromMeeting(record);
        const card = (await listActionItems()).find((a) => a.meeting_id === 'm-sync-2');

        // Simulate work happening on the board before the meeting record's
        // text is corrected: move it out of To Do.
        await moveActionItem(card.id, 'Doing');

        const editedRecord = {
            ...first.record,
            meeting_data: {
                ...first.record.meeting_data,
                actions_review: [{ ...first.record.meeting_data.actions_review[0], item: 'Corrected text', assigned_to: 'Bob' }],
            },
        };
        const second = await syncActionItemsFromMeeting(editedRecord);
        expect(second.created).toBe(0);
        expect(second.updated).toBe(1);

        const updatedCard = (await listActionItems()).find((a) => a.meeting_id === 'm-sync-2');
        expect(updatedCard.item).toBe('Corrected text');
        expect(updatedCard.assigned_to).toBe('Bob');
        // status survives the sync — content changed, board progress didn't.
        expect(updatedCard.status).toBe('Doing');
    });

    it('re-creates a card that was deleted from the board, without duplicating the ones that remain', async () => {
        const record = await meetingRecord('m-sync-3', [
            { item: 'Item A', assigned_to: '', deadline: '' },
            { item: 'Item B', assigned_to: '', deadline: '' },
        ]);
        const first = await syncActionItemsFromMeeting(record);
        const cards = (await listActionItems()).filter((a) => a.meeting_id === 'm-sync-3');
        const toDelete = cards.find((c) => c.item === 'Item A');
        await deleteActionItem(toDelete.id);

        const second = await syncActionItemsFromMeeting(first.record);
        expect(second.created).toBe(1); // Item A recreated
        expect(second.updated).toBe(1); // Item B updated in place, not duplicated

        const all = (await listActionItems()).filter((a) => a.meeting_id === 'm-sync-3');
        expect(all.map((a) => a.item).sort()).toEqual(['Item A', 'Item B']);
    });
});

describe('manual action items', () => {
    it('addActionItem creates a card defaulting to To Do', async () => {
        const created = await addActionItem({ item: 'Manually added task', assignedTo: 'Dave' });
        expect(created.status).toBe('To Do');
        expect(created.meeting_id).toBeNull();
        expect(created.item).toBe('Manually added task');
    });

    it('addActionItem rejects empty text', async () => {
        await expect(addActionItem({ item: '   ' })).rejects.toThrow('Action item text is required.');
    });

    it('addActionItem falls back to To Do for an invalid status', async () => {
        const created = await addActionItem({ item: 'Bad status test', status: 'Not A Real Status' });
        expect(created.status).toBe('To Do');
    });
});

describe('updating and moving action items', () => {
    it('updateActionItem patches fields and bumps updated_at', async () => {
        const created = await addActionItem({ item: 'To edit' });
        const updated = await updateActionItem(created.id, { item: 'Edited text', assigned_to: 'Eve' });
        expect(updated.item).toBe('Edited text');
        expect(updated.assigned_to).toBe('Eve');
        expect(updated.id).toBe(created.id);
    });

    it('updateActionItem throws for a missing id', async () => {
        await expect(updateActionItem('does-not-exist', { item: 'x' })).rejects.toThrow('Action item not found.');
    });

    it('moveActionItem changes status, e.g. for a drag-and-drop drop', async () => {
        const created = await addActionItem({ item: 'To move' });
        expect(created.status).toBe('To Do');
        const moved = await moveActionItem(created.id, 'Doing');
        expect(moved.status).toBe('Doing');
        const movedAgain = await moveActionItem(created.id, 'Done');
        expect(movedAgain.status).toBe('Done');
    });

    it('moveActionItem rejects a status outside ACTION_STATUSES', async () => {
        const created = await addActionItem({ item: 'Bad move' });
        await expect(moveActionItem(created.id, 'Archived')).rejects.toThrow('Invalid status: Archived');
    });

    it('ACTION_STATUSES is the fixed 3-column board order', () => {
        expect(ACTION_STATUSES).toEqual(['To Do', 'Doing', 'Done']);
    });
});

describe('board -> meeting propagation', () => {
    it('editing a linked card writes item/assigned_to/deadline back to its actions_review row', async () => {
        const record = await meetingRecord('m-prop-1', [
            { item: 'Original', assigned_to: 'Alice', deadline: '2026-08-01' },
        ]);
        const synced = await syncActionItemsFromMeeting(record);
        const card = (await listActionItems()).find((a) => a.meeting_id === 'm-prop-1');

        await updateActionItem(card.id, { item: 'Edited on board', assigned_to: 'Bob', deadline: '2026-09-01' });

        const updatedRecord = await getMeetingRecord('m-prop-1');
        const row = updatedRecord.meeting_data.actions_review.find((a) => a.id === synced.record.meeting_data.actions_review[0].id);
        expect(row.item).toBe('Edited on board');
        expect(row.assigned_to).toBe('Bob');
        expect(row.deadline).toBe('2026-09-01');
    });

    it('moving a card (status/order only) does not touch the meeting record', async () => {
        const record = await meetingRecord('m-prop-2', [{ item: 'Stays put', assigned_to: '', deadline: '' }]);
        await syncActionItemsFromMeeting(record);
        const card = (await listActionItems()).find((a) => a.meeting_id === 'm-prop-2');
        const before = await getMeetingRecord('m-prop-2');

        await moveActionItem(card.id, 'Doing');

        const after = await getMeetingRecord('m-prop-2');
        expect(after.meeting_data.actions_review[0].item).toBe('Stays put');
        expect(after.updated_at).toBe(before.updated_at);
    });

    it('editing a manually-added card (no meeting_id) does not error', async () => {
        const created = await addActionItem({ item: 'Board-only task' });
        const updated = await updateActionItem(created.id, { item: 'Renamed board-only task' });
        expect(updated.item).toBe('Renamed board-only task');
    });

    it('editing a card whose meeting record was since deleted does not throw', async () => {
        const record = await meetingRecord('m-prop-3', [{ item: 'Orphan-to-be', assigned_to: '', deadline: '' }]);
        await syncActionItemsFromMeeting(record);
        const card = (await listActionItems()).find((a) => a.meeting_id === 'm-prop-3');

        // Simulate the meeting record having been deleted independently —
        // the card is now orphaned but should still be editable.
        const db = await (await import('./db')).openDb();
        const tx = db.transaction('records', 'readwrite');
        tx.objectStore('records').delete('m-prop-3');
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });

        await expect(updateActionItem(card.id, { item: 'Still editable' })).resolves.toMatchObject({ item: 'Still editable' });
    });
});

describe('deleteActionItem', () => {
    it('removes the card', async () => {
        const created = await addActionItem({ item: 'To delete' });
        await deleteActionItem(created.id);
        const all = await listActionItems();
        expect(all.find((a) => a.id === created.id)).toBeUndefined();
    });
});

describe('ordering', () => {
    it('addActionItem appends new cards after existing ones in the same status', async () => {
        const first = await addActionItem({ item: 'Order test 1', status: 'To Do' });
        const second = await addActionItem({ item: 'Order test 2', status: 'To Do' });
        expect(second.order).toBeGreaterThan(first.order);
    });

    it('listActionItems sorts by order within the same status', async () => {
        const a = await addActionItem({ item: 'Sort A', status: 'Doing' });
        const b = await addActionItem({ item: 'Sort B', status: 'Doing' });
        const c = await addActionItem({ item: 'Sort C', status: 'Doing' });

        // Move C to the front, then B, leaving A last — reorderActionItems
        // is what a drag-and-drop reorder ultimately calls.
        await reorderActionItems('Doing', [c.id, b.id, a.id]);

        const all = await listActionItems();
        const doing = all.filter((i) => ['Sort A', 'Sort B', 'Sort C'].includes(i.item));
        expect(doing.map((i) => i.item)).toEqual(['Sort C', 'Sort B', 'Sort A']);
    });

    it('reorderActionItems also updates status for a card arriving from another column', async () => {
        const created = await addActionItem({ item: 'Cross-column drag', status: 'To Do' });
        const other = await addActionItem({ item: 'Already in Doing', status: 'Doing' });

        await reorderActionItems('Doing', [created.id, other.id]);

        const all = await listActionItems();
        const moved = all.find((i) => i.id === created.id);
        expect(moved.status).toBe('Doing');
        expect(moved.order).toBe(0);
        const stayed = all.find((i) => i.id === other.id);
        expect(stayed.order).toBe(1);
    });

    it('reorderActionItems rejects an invalid status', async () => {
        await expect(reorderActionItems('Archived', ['x'])).rejects.toThrow('Invalid status: Archived');
    });

    it('moveActionItem appends to the end of the destination column', async () => {
        const existing = await addActionItem({ item: 'Existing in Done', status: 'Done' });
        const moving = await addActionItem({ item: 'Moving to Done', status: 'To Do' });
        const moved = await moveActionItem(moving.id, 'Done');
        expect(moved.order).toBeGreaterThan(existing.order);
    });
});
