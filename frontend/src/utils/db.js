// Shared IndexedDB connection for everything derived from meeting records
// (the records/audio themselves in meetingStore.js, and the action items
// board in actionItemStore.js). One database, one place that defines the
// full set of object stores and owns the version number — IndexedDB
// requires every store to be declared inside a single onupgradeneeded
// handler tied to a version bump, so splitting store creation across
// multiple independent `indexedDB.open()` callers would race on which one
// actually defines the schema.

export const DB_NAME = 'ikea-meeting-records';
export const DB_VERSION = 2;

export const RECORDS_STORE = 'records';
export const AUDIO_STORE = 'audio';
export const ACTION_ITEMS_STORE = 'action_items';

let dbPromise = null;

export function openDb() {
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
                if (!db.objectStoreNames.contains(ACTION_ITEMS_STORE)) {
                    const store = db.createObjectStore(ACTION_ITEMS_STORE, { keyPath: 'id' });
                    // Lets importActionItemsFromMeeting() check "has this meeting
                    // already been imported" without scanning every row.
                    store.createIndex('by_meeting_id', 'meeting_id', { unique: false });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    return dbPromise;
}

export function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export function promisifyTransaction(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    });
}
