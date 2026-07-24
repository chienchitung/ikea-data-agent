import { describe, it, expect } from 'vitest';
import {
    listActionItems,
    hasImportedActionsForMeeting,
    importActionItemsFromMeeting,
    addActionItem,
    updateActionItem,
    moveActionItem,
    deleteActionItem,
    ACTION_STATUSES,
} from './actionItemStore';

function meetingRecord(id, actions) {
    return {
        meeting_id: id,
        meeting_data: {
            meeting_title: `Meeting ${id}`,
            actions_review: actions,
        },
    };
}

describe('importActionItemsFromMeeting', () => {
    it('creates one To Do card per action item, tagged with the source meeting', async () => {
        const record = meetingRecord('m-import-1', [
            { no: 1, item: 'Finalize API doc', assigned_to: 'Bob', deadline: '2026-08-01' },
            { no: 2, item: 'Review budget', assigned_to: 'Alice', deadline: '2026-08-05' },
        ]);

        const created = await importActionItemsFromMeeting(record);
        expect(created).toHaveLength(2);
        expect(created.every((c) => c.status === 'To Do')).toBe(true);
        expect(created.every((c) => c.meeting_id === 'm-import-1')).toBe(true);
        expect(created.every((c) => c.meeting_title === 'Meeting m-import-1')).toBe(true);

        const all = await listActionItems();
        const imported = all.filter((a) => a.meeting_id === 'm-import-1');
        expect(imported.map((a) => a.item).sort()).toEqual(['Finalize API doc', 'Review budget']);
    });

    it('skips action items with empty text', async () => {
        const record = meetingRecord('m-import-2', [
            { item: '', assigned_to: 'Nobody', deadline: '' },
            { item: '  ', assigned_to: 'Nobody', deadline: '' },
            { item: 'Real action', assigned_to: 'Carol', deadline: '2026-09-01' },
        ]);
        const created = await importActionItemsFromMeeting(record);
        expect(created).toHaveLength(1);
        expect(created[0].item).toBe('Real action');
    });

    it('returns an empty array when the meeting has no actions_review', async () => {
        expect(await importActionItemsFromMeeting(meetingRecord('m-import-3', []))).toEqual([]);
        expect(await importActionItemsFromMeeting({ meeting_id: 'm-import-4', meeting_data: {} })).toEqual([]);
    });

    it('hasImportedActionsForMeeting reflects whether that meeting has been imported', async () => {
        const record = meetingRecord('m-import-5', [{ item: 'Something', assigned_to: '', deadline: '' }]);
        expect(await hasImportedActionsForMeeting('m-import-5')).toBe(false);
        await importActionItemsFromMeeting(record);
        expect(await hasImportedActionsForMeeting('m-import-5')).toBe(true);
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

describe('deleteActionItem', () => {
    it('removes the card', async () => {
        const created = await addActionItem({ item: 'To delete' });
        await deleteActionItem(created.id);
        const all = await listActionItems();
        expect(all.find((a) => a.id === created.id)).toBeUndefined();
    });
});
