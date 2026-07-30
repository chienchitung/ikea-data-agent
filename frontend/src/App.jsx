import { useState, useRef, useEffect, useLayoutEffect, useMemo, lazy, Suspense } from 'react';
import axios from 'axios';
import { ChatMessage } from './components/ChatMessage';
import { ArrowUp, Loader2, Sparkles, FileText, ChevronDown, ChevronLeft, Plus, Check, Edit2, Trash2, User, MessageSquare, PenSquare, Search, Mic, Square, X, Bug, Pin, MoreHorizontal, KeyRound, Eye, EyeOff, CheckSquare, FileAudio, Menu, Kanban } from 'lucide-react';
import { listMeetingRecords, getMeetingRecord, formatMeetingRecordForContext } from './utils/meetingStore';
import bearAvatar from './assets/img/ikea-bear.webp';
import dogAvatar from './assets/img/ikea-dog.webp';
import elephantAvatar from './assets/img/ikea-elephant.webp';
import monkeyAvatar from './assets/img/ikea-monkey.webp';
import sharkAvatar from './assets/img/ikea-shark.webp';
import teddyAvatar from './assets/img/ikea-teddy.webp';
import { readSseStream } from './utils/sse';

// Meeting Records is a whole separate page (recorder modal, minutes editor,
// IndexedDB storage layer) that most chat sessions never open — lazy-loading
// it keeps that code out of the initial bundle everyone downloads just to
// chat. See the <Suspense> around its one usage below.
const MeetingRecordsPage = lazy(() =>
    import('./components/MeetingRecordsPage').then((m) => ({ default: m.MeetingRecordsPage }))
);

// Same rationale as MeetingRecordsPage above, plus it pulls in @dnd-kit/core
// for the drag-and-drop board — no reason to ship that to everyone either.
const ActionItemsBoard = lazy(() =>
    import('./components/ActionItemsBoard').then((m) => ({ default: m.ActionItemsBoard }))
);

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const SHOW_AI_DEBUG = import.meta.env.DEV && import.meta.env.VITE_DEBUG_AI === 'true';
const STORAGE_KEY = 'ikea_agent_conversations';
const CURRENT_ID_KEY = 'ikea_agent_current_id';
const GEMINI_KEY_STORAGE = 'ikea_agent_gemini_key';
const GROQ_KEY_STORAGE = 'ikea_agent_groq_key';
const ACTIVE_DOCS_STORAGE = 'ikea_agent_active_docs';
const ACTIVE_MEETINGS_STORAGE = 'ikea_agent_active_meetings';
// Below this usage ratio the footer just shows a one-line "X MB used" —
// no point in a progress bar + cleanup hint when there's nothing to worry
// about yet. At/above it, the full bar + hint appears; the existing 0.85
// cutoff below still switches the bar to red for "actually getting full".
const STORAGE_BAR_EXPAND_THRESHOLD = 0.5;
// Matches backend/agent_logic.py's _MEETING_CONTEXT_TOTAL_CHAR_LIMIT (24000)
// with headroom — warn before the backend actually starts dropping meetings
// for being over budget, not after.
const ACTIVE_MEETINGS_WARN_CHAR_THRESHOLD = 18000;

const AVATARS = [
    { id: 'bear', name: 'Bear', src: bearAvatar },
    { id: 'dog', name: 'Dog', src: dogAvatar },
    { id: 'elephant', name: 'Elephant', src: elephantAvatar },
    { id: 'monkey', name: 'Monkey', src: monkeyAvatar },
    { id: 'shark', name: 'Shark', src: sharkAvatar },
    { id: 'teddy', name: 'Teddy', src: teddyAvatar },
];

const UI_TRANSLATIONS = {
    '正在理解問題': 'Understanding your question',
    '正在判斷脈絡': 'Checking context',
    '正在選擇合適工具': 'Choosing the right tool',
    '正在整合上下文': 'Combining context',
    '正在查詢資料': 'Searching data',
    '正在等待工具回傳': 'Waiting for tool results',
    '正在整理回覆': 'Drafting the response',
    '正在根據上下文整理回覆': 'Drafting from context',
    '正在準備查詢資料': 'Preparing data lookup',
    '正在重新選擇資料工具': 'Choosing a different data tool',
    '正在讀取工作表清單': 'Reading worksheet list',
    '正在檢查工作表欄位': 'Checking worksheet fields',
    '正在查詢工作表資料': 'Querying worksheet data',
    '正在搜尋 Confluence': 'Searching Confluence',
    '正在讀取 Confluence 內容': 'Reading Confluence content',
    '正在整理 Confluence 頁面': 'Organizing Confluence pages',
    '正在查詢 Trello 進度': 'Checking Trello progress',
    '正在讀取 Trello 卡片': 'Reading Trello card',
    '正在搜尋 Trello 卡片': 'Searching Trello card',
    '正在查詢 get_project_status': 'Checking Trello progress',
    '正在查詢 search_document_base': 'Searching PDF knowledge base',
    '正在重新整理回答': 'Regenerating the response',
    '正在組織新版回覆': 'Preparing the new response',
    '正在搜尋 PDF 知識庫': 'Searching PDF knowledge base',
    '正在搜尋 Trello 專案': 'Searching Trello projects',
    '正在搜尋 Confluence 文件': 'Searching Confluence documents',
    '正在分析資料': 'Analyzing data',
    '正在轉交給專家 Agent': 'Routing to the right agent',
    '自行輸入': 'Custom',
    '用自己的文字補充需求': 'Add details in your own words',
    '選擇一個方向後，我會再查資料。': 'Choose a direction and I will continue searching.',
    '幫我補一下方向': 'Help me narrow this down',
    '目前連不到後端服務': 'Backend service is unreachable',
    '我沒有收到後端回應，所以這次請求沒有完成。': 'I did not receive a backend response, so this request was not completed.',
    '確認 backend server 是否正在執行': 'Check that the backend server is running',
    '稍後再試一次': 'Try again later',
    '檔案或請求太大': 'File or request is too large',
    '這次送出的內容超過後端可處理的大小。': 'The submitted content is larger than the backend can process.',
    '縮小檔案後重新上傳': 'Reduce the file size and upload again',
    '或把問題拆成較小範圍': 'Or split the question into a smaller scope',
    'PDF 上傳沒有完成': 'PDF upload did not finish',
    '上傳或解析 PDF 時發生錯誤。': 'An error occurred while uploading or parsing the PDF.',
    '確認 PDF 可以正常開啟': 'Confirm that the PDF opens correctly',
    '稍後重新上傳一次': 'Upload it again later',
    '重新生成失敗': 'Regeneration failed',
    '我無法重新整理這則回答。': 'I could not regenerate this answer.',
    '或直接用新的訊息補充你想修改的方向': 'Or send a new message with the changes you want',
    '處理過程中斷了': 'Processing was interrupted',
    '後端處理請求時發生錯誤。': 'The backend encountered an error while processing the request.',
    '稍後重試一次': 'Try again later',
    '如果問題很長，先縮小範圍再問': 'If the question is long, narrow the scope first',
};

// ── 工具函式 ────────────────────────────────────────────
function generateId() {
    return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function toEnglishUiText(value) {
    if (typeof value !== 'string') return value;
    return UI_TRANSLATIONS[value] || value;
}

function hasCjkText(value) {
    return typeof value === 'string' && /[\u3400-\u9fff]/.test(value);
}

function toEnglishUiList(values = []) {
    return values.map(item => toEnglishUiText(item));
}

function makeTitle(messages) {
    const first = messages.find(m => m.role === 'user');
    if (!first) return 'New conversation';
    return first.content.length > 40 ? first.content.slice(0, 40) + '…' : first.content;
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

// Used by the conversation search panel: when a match comes from message
// content rather than the title (already shown as the result's heading),
// this gives a short "why this matched" preview centered on the hit instead
// of just the message's first ~30 characters, which for a long reply would
// usually not even contain the matched word.
function buildMatchSnippet(content, query) {
    const lower = content.toLowerCase();
    const index = lower.indexOf(query);
    if (index === -1) return content.slice(0, 80);
    const start = Math.max(0, index - 30);
    const end = Math.min(content.length, index + query.length + 30);
    let snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = `…${snippet}`;
    if (end < content.length) snippet = `${snippet}…`;
    return snippet;
}

function loadConversations() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveConversations(convs) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(convs));
}

function formatMb(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const mb = bytes / (1024 * 1024);
    if (mb >= 100) return `${Math.round(mb).toLocaleString()} MB`;
    return `${mb.toFixed(1)} MB`;
}

function getResponseStatusLabel(phase, elapsedSeconds) {
    if (phase === 'understanding') {
        if (elapsedSeconds < 3) return 'Understanding your question';
        return 'Checking context';
    }

    if (phase === 'thinking') {
        if (elapsedSeconds < 6) return 'Choosing the right tool';
        return 'Combining context';
    }

    if (phase === 'tool' || phase === 'searching') {
        if (elapsedSeconds < 8) return 'Searching data';
        return 'Waiting for tool results';
    }

    if (phase === 'composing') {
        return 'Drafting the response';
    }

    if (phase === 'regenerating') {
        if (elapsedSeconds < 6) return 'Regenerating the response';
        return 'Preparing the new response';
    }

    if (elapsedSeconds < 5) return 'Searching data';
    if (elapsedSeconds < 14) return 'Combining context';
    return 'Drafting the response';
}

function detectMessageLanguage(value) {
    const text = String(value || '');
    const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const englishChars = (text.match(/[A-Za-z]{2,}/g) || []).join('').length;
    if (cjkCount === 0 && englishChars > 0) return 'en';
    if (englishChars === 0 && cjkCount > 0) return 'zh';
    return englishChars > cjkCount * 1.5 ? 'en' : 'zh';
}

function formatAssistantNotice(title, message, nextSteps = [], language = 'en') {
    const displayTitle = language === 'zh' ? title : toEnglishUiText(title);
    const displayMessage = language === 'zh' ? message : toEnglishUiText(message);
    const displaySteps = language === 'zh' ? nextSteps : toEnglishUiList(nextSteps);
    let content = `**${displayTitle}**\n\n${displayMessage}`;
    if (nextSteps.length > 0) {
        const helper = language === 'zh' ? '你可以試試：' : 'You can try:';
        content += `\n\n${helper}\n${displaySteps.map(step => `- ${step}`).join('\n')}`;
    }
    return content;
}

function getStructuredError(error) {
    const detail = error?.response?.data?.detail || error?.response?.data;
    if (detail && typeof detail === 'object') {
        return {
            title: detail.title,
            message: detail.message,
            nextSteps: detail.next_steps || detail.nextSteps || [],
            code: detail.code,
        };
    }
    return null;
}

function buildRequestErrorMessage(error, context = 'chat', userMessage = '') {
    const language = detectMessageLanguage(userMessage);
    const zh = language === 'zh';
    const structured = getStructuredError(error);
    if (structured?.title && structured?.message) {
        return formatAssistantNotice(structured.title, structured.message, structured.nextSteps, language);
    }

    if (!error?.response) {
        return formatAssistantNotice(
            zh ? '目前連不到後端服務' : 'Backend service is unreachable',
            zh ? '我沒有收到後端回應，所以這次請求沒有完成。' : 'I did not receive a backend response, so this request was not completed.',
            zh ? ['確認 backend server 是否正在執行', '稍後再試一次'] : ['Check that the backend server is running', 'Try again later'],
            language
        );
    }

    if (error.response.status === 413) {
        return formatAssistantNotice(
            zh ? '檔案或請求太大' : 'File or request is too large',
            zh ? '這次送出的內容超過後端可處理的大小。' : 'The submitted content is larger than the backend can process.',
            zh ? ['縮小檔案後重新上傳', '或把問題拆成較小範圍'] : ['Reduce the file size and upload again', 'Or split the question into a smaller scope'],
            language
        );
    }

    if (context === 'upload') {
        return formatAssistantNotice(
            zh ? 'PDF 上傳沒有完成' : 'PDF upload did not finish',
            error.response?.data?.message || error.message || (zh ? '上傳或解析 PDF 時發生錯誤。' : 'An error occurred while uploading or parsing the PDF.'),
            zh ? ['確認 PDF 可以正常開啟', '稍後重新上傳一次'] : ['Confirm that the PDF opens correctly', 'Upload it again later'],
            language
        );
    }

    if (context === 'regenerate') {
        return formatAssistantNotice(
            zh ? '重新生成失敗' : 'Regeneration failed',
            zh ? '我無法重新整理這則回答。' : 'I could not regenerate this answer.',
            zh ? ['稍後再試一次', '或直接用新的訊息補充你想修改的方向'] : ['Try again later', 'Or send a new message with the changes you want'],
            language
        );
    }

    return formatAssistantNotice(
        zh ? '處理過程中斷了' : 'Processing was interrupted',
        error.response?.data?.message || error.message || (zh ? '後端處理請求時發生錯誤。' : 'The backend encountered an error while processing the request.'),
        zh ? ['稍後重試一次', '如果問題很長，先縮小範圍再問'] : ['Try again later', 'If the question is long, narrow the scope first'],
        language
    );
}

async function streamChat(payload, signal, onProgress, geminiApiKey) {
    const body = geminiApiKey ? { ...payload, gemini_api_key: geminiApiKey } : payload;
    const response = await fetch(`${API_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        const data = await response.json().catch(() => null);
        const error = new Error(data?.detail?.message || data?.message || `Request failed with status ${response.status}`);
        error.response = { status: response.status, data };
        throw error;
    }

    let finalPayload = null;
    let errorPayload = null;

    await readSseStream(response, (event, data) => {
        if (event === 'progress') {
            onProgress(data || {});
        } else if (event === 'final') {
            finalPayload = data || {};
        } else if (event === 'error') {
            errorPayload = data || {};
        }
    });

    if (errorPayload) {
        const error = new Error(errorPayload.message || 'Stream ended with an error.');
        error.response = { data: errorPayload };
        throw error;
    }

    if (!finalPayload) {
        throw new Error('Stream ended before a final response was returned.');
    }

    return finalPayload;
}
// ────────────────────────────────────────────────────────

function App() {
    const [input, setInput] = useState("");
    const [messages, setMessages] = useState([]);
    const [currentConvId, setCurrentConvId] = useState(null);
    const [conversations, setConversations] = useState([]);
    const [documents, setDocuments] = useState([]);
    const [selectedDocuments, setSelectedDocuments] = useState(() => {
        try { return new Set(JSON.parse(localStorage.getItem(ACTIVE_DOCS_STORAGE) || '[]')); }
        catch { return new Set(); }
    });
    // 會議記錄清單（來自瀏覽器 IndexedDB，見 meetingStore.js）以及使用者
    // 勾選要加入這輪對話上下文的項目——跟 documents/selectedDocuments 是
    // 平行的一套機制，差別只在資料來源（後端 vs. IndexedDB）。
    const [meetingRecords, setMeetingRecords] = useState([]);
    const [selectedMeetings, setSelectedMeetings] = useState(() => {
        try { return new Set(JSON.parse(localStorage.getItem(ACTIVE_MEETINGS_STORAGE) || '[]')); }
        catch { return new Set(); }
    });
    const [isMeetingSourcesExpanded, setIsMeetingSourcesExpanded] = useState(true);
    // 目前勾選的會議記錄格式化後的總字數估計，只用來在側欄提示「選太多會
    // 拖慢速度」——真正的防呆（總量上限、超過就跳過）在後端
    // _build_meeting_context_messages 做，這裡只是提前告知使用者。
    const [activeMeetingsCharCount, setActiveMeetingsCharCount] = useState(0);
    const [showMeetingsPage, setShowMeetingsPage] = useState(false);
    const [showActionBoard, setShowActionBoard] = useState(false);
    // Set right before switching to the Meeting Records page so it opens
    // straight to that meeting's detail view (used by the Action Items
    // board's "open source meeting" link). Cleared whenever navigating away
    // from Meeting Records so a later plain visit to that page doesn't
    // reopen a stale deep link.
    const [openMeetingId, setOpenMeetingId] = useState(null);
    const [loadingConvIds, setLoadingConvIds] = useState(new Set());
    const [convStatuses, setConvStatuses] = useState({});
    const [clarifyingConvId, setClarifyingConvId] = useState(null);
    const [displayElapsedSeconds, setDisplayElapsedSeconds] = useState(0);
    const [isUploading, setIsUploading] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [speechSupported, setSpeechSupported] = useState(true);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadStage, setUploadStage] = useState("");
    const [clarification, setClarification] = useState(null);
    const [clarificationAnswers, setClarificationAnswers] = useState({});
    const [clarificationCustomAnswers, setClarificationCustomAnswers] = useState({});
    const [pendingMessage, setPendingMessage] = useState("");
    const [pendingHistorySnapshot, setPendingHistorySnapshot] = useState([]);
    const [pendingTurnContext, setPendingTurnContext] = useState({});
    const [pendingConversationId, setPendingConversationId] = useState(null);
    const [isSourcesExpanded, setIsSourcesExpanded] = useState(true);
    // 瀏覽器回報的本站儲存用量/配額（navigator.storage.estimate）。
    // 顯示在 Sources 區塊底部，提醒使用者適時清理來源與舊對話。
    const [storageEstimate, setStorageEstimate] = useState(null);
    const [isConvsExpanded, setIsConvsExpanded] = useState(true);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
        () => typeof window !== 'undefined' && window.innerWidth < 768
    );
    const [renamingDoc, setRenamingDoc] = useState(null);
    const [newDocName, setNewDocName] = useState("");
    const [renamingConvId, setRenamingConvId] = useState(null);
    const [renamingConvTitle, setRenamingConvTitle] = useState("");
    const [isSelectingConvs, setIsSelectingConvs] = useState(false);
    const [selectedConvIds, setSelectedConvIds] = useState(new Set());
    // Search-conversations panel — same concept as Claude's own conversation
    // search: a command-palette-style overlay, not an inline sidebar filter.
    const [showConvSearch, setShowConvSearch] = useState(false);
    const [convSearchQuery, setConvSearchQuery] = useState('');
    const [convSearchActiveIndex, setConvSearchActiveIndex] = useState(0);
    const convSearchInputRef = useRef(null);
    const [isSelectingDocs, setIsSelectingDocs] = useState(false);
    const [selectedDocIdsForDelete, setSelectedDocIdsForDelete] = useState(new Set());
    const [openMenuConvId, setOpenMenuConvId] = useState(null);
    const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
    const [userAvatar, setUserAvatar] = useState(bearAvatar);
    const [showAvatarPicker, setShowAvatarPicker] = useState(false);
    // 面板位置由按鈕實際位置量測而來（見 avatar 按鈕 onClick），不是釘死在
    // 視窗右邊界——header 內容置中在 max-w-4xl 欄位內，螢幕越寬，人形圖示
    // 離視窗右邊界就越遠，寫死 right-* 會讓面板跟圖示分離、飄向真正的視窗邊緣。
    const [avatarPanelPosition, setAvatarPanelPosition] = useState({ top: 0, left: 0 });
    const [debugMode, setDebugMode] = useState(false);
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [apiKeyVisible, setApiKeyVisible] = useState(false);
    const [geminiApiKey, setGeminiApiKey] = useState(() => localStorage.getItem(GEMINI_KEY_STORAGE) || '');
    const [groqApiKeyInput, setGroqApiKeyInput] = useState('');
    const [groqApiKeyVisible, setGroqApiKeyVisible] = useState(false);
    const [groqApiKey, setGroqApiKey] = useState(() => localStorage.getItem(GROQ_KEY_STORAGE) || '');
    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);
    const abortControllersRef = useRef(new Map());
    const clarificationAbortRef = useRef(null);
    const currentConvIdRef = useRef(null);
    const conversationsRef = useRef([]);
    const messagesRef = useRef([]);
    // Lags one render behind currentConvId (unlike currentConvIdRef, which
    // switchConversation() updates eagerly, in sync with the state setters)
    // so the messages-save effect below can tell "messages changed because
    // the user switched to a different, already-saved conversation" apart
    // from "messages changed because this conversation's content actually
    // changed" -- see that effect for why the distinction matters.
    const lastSavedConvIdRef = useRef(null);
    const recognitionRef = useRef(null);
    const speechBaseInputRef = useRef("");
    const speechTranscriptRef = useRef("");
    const speechInterimRef = useRef("");
    const speechErrorRef = useRef(false);
    const speechDiscardRef = useRef(false);
    const isListeningRef = useRef(false);
    // 手機瀏覽器（尤其 iOS Safari、以及 Android 音訊裝置搶用時）的語音辨識
    // session 常常啟動後幾百毫秒內就自行觸發 onend，若無節流會形成
    // start→onend→start 的緊密迴圈，佔滿主執行緒，使用者感受是「整個
    // 網頁卡頓」。這兩個 ref 記錄短時間內的重啟次數，超過門檻就放棄。
    const speechRestartTimestampsRef = useRef([]);
    const speechRestartTimeoutRef = useRef(null);
    const pendingScrollBehaviorRef = useRef("auto");
    const isCurrentConvLoading = loadingConvIds.has(currentConvId);
    // 串流中的答案已經開始顯示（Phase 3 的 streaming 佔位訊息存在）。
    // 泡泡的渲染條件要排除這個狀態：答案逐字浮現時，底部不該再掛著
    // 轉圈泡泡；interim 重試清空佔位訊息時，條件自動翻回、泡泡自動回來。
    const lastMessage = messages[messages.length - 1];
    const isStreamingAnswerVisible = Boolean(lastMessage?.streaming && lastMessage?.role === 'assistant');
    // clarifyingConvId 和 currentConvId 的初始值都是 null——全新裝置
    // （localStorage 沒有任何對話，currentConvId 不會被載入流程設值）上
    // null === null 會把整個介面誤判成「釐清進行中」：輸入框停用、
    // 麥克風停用、送出鍵永遠顯示成暫停鍵。必須先確認真的有釐清在跑。
    const isClarifyingCurrentConv = clarifyingConvId !== null && clarifyingConvId === currentConvId;
    const currentStatus = convStatuses[currentConvId] || {};
    const responsePhase = currentStatus.phase || 'idle';
    const responseStatusText = currentStatus.statusText || '';
    const responseStatusLabel = responseStatusText || getResponseStatusLabel(responsePhase, displayElapsedSeconds);

    useEffect(() => {
        currentConvIdRef.current = currentConvId;
    }, [currentConvId]);

    useEffect(() => {
        isListeningRef.current = isListening;
    }, [isListening]);

    useEffect(() => {
        conversationsRef.current = conversations;
    }, [conversations]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    // ── 初始化：從 localStorage 載入 ─────────────────────
    useEffect(() => {
        const saved = loadConversations();
        setConversations(saved);
        const lastId = localStorage.getItem(CURRENT_ID_KEY);
        const found = saved.find(c => c.id === lastId);
        if (found) {
            setCurrentConvId(found.id);
            setMessages(found.messages);
        } else if (lastId) {
            setCurrentConvId(lastId);
            setMessages([]);
        } else if (saved.length > 0) {
            setCurrentConvId(saved[0].id);
            setMessages(saved[0].messages);
        }
    }, []);

    // ── 瀏覽器儲存用量：掛載時與資料變動時刷新 ─────────────
    useEffect(() => {
        let cancelled = false;
        if (!navigator.storage?.estimate) return undefined;
        navigator.storage.estimate().then(({ usage, quota }) => {
            if (!cancelled && Number.isFinite(usage) && Number.isFinite(quota)) {
                setStorageEstimate({ usage, quota });
            }
        }).catch(() => { /* 老瀏覽器或隱私模式拿不到就整塊隱藏 */ });
        return () => { cancelled = true; };
    }, [documents, conversations]);

    // ── messages 變動時自動存檔 ───────────────────────────
    // switchConversation() loads an existing conversation's own messages
    // into this same `messages` state var, which fires this effect exactly
    // like a genuine content change would -- without the isSwitch check
    // below, merely clicking an older conversation in the sidebar stamped
    // it with a fresh updatedAt and bounced it to the top of the
    // (activity-sorted) list, even though nothing about it actually changed.
    useEffect(() => {
        // No `!== null` guard: the very first time this effect sees a real
        // currentConvId (e.g. resuming the last-open conversation on page
        // load) is exactly the same kind of "just switched into view, no
        // new content" case as clicking a different conversation, so it
        // must skip the save the same way.
        const isSwitch = lastSavedConvIdRef.current !== currentConvId;
        lastSavedConvIdRef.current = currentConvId;

        if (messages.length === 0) return;
        if (isSwitch) return;

        setConversations(prev => {
            let updated;
            const exists = prev.find(c => c.id === currentConvId);
            if (exists) {
                updated = prev.map(c =>
                    c.id === currentConvId
                        ? { ...c, messages, title: c.autoTitle === false ? c.title : makeTitle(messages), updatedAt: Date.now() }
                        : c
                );
            } else {
                const newConv = {
                    id: currentConvId,
                    title: makeTitle(messages),
                    messages,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
                updated = [newConv, ...prev];
            }
            saveConversations(updated);
            return updated;
        });
    }, [messages, currentConvId]);

    const updateConversationMessages = (convId, updater) => {
        if (!convId) return;

        const currentMessages = currentConvIdRef.current === convId
            ? messagesRef.current
            : conversationsRef.current.find(c => c.id === convId)?.messages || [];
        const nextMessages = typeof updater === 'function' ? updater(currentMessages) : updater;
        const existing = conversationsRef.current.find(c => c.id === convId);
        // Bug 1 fix: don't resurrect a conversation that was deleted
        if (!existing && currentConvIdRef.current !== convId) return;
        const nextConversation = existing
            ? { ...existing, messages: nextMessages, title: existing.autoTitle === false ? existing.title : makeTitle(nextMessages), updatedAt: Date.now() }
            : {
                id: convId,
                title: makeTitle(nextMessages),
                messages: nextMessages,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
        const updated = existing
            ? conversationsRef.current.map(c => c.id === convId ? nextConversation : c)
            : [nextConversation, ...conversationsRef.current];

        conversationsRef.current = updated;
        saveConversations(updated);
        setConversations(updated);

        if (currentConvIdRef.current === convId) {
            messagesRef.current = nextMessages;
            setMessages(nextMessages);
        }
    };

    // currentConvId 變動時同步到 localStorage
    useEffect(() => {
        if (currentConvId) localStorage.setItem(CURRENT_ID_KEY, currentConvId);
    }, [currentConvId]);

    // selectedDocuments 變動時同步到 localStorage
    useEffect(() => {
        localStorage.setItem(ACTIVE_DOCS_STORAGE, JSON.stringify([...selectedDocuments]));
    }, [selectedDocuments]);

    // selectedMeetings 變動時同步到 localStorage（比照 selectedDocuments）
    useEffect(() => {
        localStorage.setItem(ACTIVE_MEETINGS_STORAGE, JSON.stringify([...selectedMeetings]));
    }, [selectedMeetings]);

    const scrollToBottom = (behavior = "smooth") => {
        messagesEndRef.current?.scrollIntoView({ behavior });
    };

    const fetchDocuments = async () => {
        try {
            const response = await axios.get(`${API_URL}/documents`);
            const fetched = response.data.documents || [];
            setDocuments(fetched);
            const fetchedSet = new Set(fetched);
            setSelectedDocuments(prev => {
                const pruned = new Set([...prev].filter(d => fetchedSet.has(d)));
                return pruned.size === prev.size ? prev : pruned;
            });
        } catch (error) {
            console.error("Failed to fetch documents:", error);
        }
    };

    const fetchMeetingRecords = async () => {
        try {
            const records = await listMeetingRecords();
            setMeetingRecords(records);
            const fetchedIds = new Set(records.map(r => r.meeting_id));
            setSelectedMeetings(prev => {
                const pruned = new Set([...prev].filter(id => fetchedIds.has(id)));
                return pruned.size === prev.size ? prev : pruned;
            });
        } catch (error) {
            console.error("Failed to load meeting records:", error);
        }
    };

    useLayoutEffect(() => {
        // Meeting Records / Action Items are rendered instead of (not
        // alongside) the chat <main>, so returning to chat remounts it at a
        // fresh scroll position. messages/isCurrentConvLoading don't change
        // on that transition, so this effect needs both page flags in its
        // deps too, or the remounted view is silently left scrolled to the top.
        if (showMeetingsPage || showActionBoard) return;
        if (messages.length === 0 && !isCurrentConvLoading) return;

        const behavior = pendingScrollBehaviorRef.current;
        scrollToBottom(behavior);
        pendingScrollBehaviorRef.current = "smooth";
    }, [messages, isCurrentConvLoading, showMeetingsPage, showActionBoard]);

    useEffect(() => {
        fetchDocuments();
    }, []);

    // 首次掛載時載入一次；之後每次從「會議記錄」頁面切回聊天畫面時重新
    // 讀取一次（那個頁面自己管理新增/刪除，離開時側欄清單才需要跟著更新）。
    useEffect(() => {
        if (showMeetingsPage) return;
        fetchMeetingRecords();
    }, [showMeetingsPage]);

    useEffect(() => {
        if (!isCurrentConvLoading) {
            setDisplayElapsedSeconds(0);
            return;
        }
        const startedAt = convStatuses[currentConvId]?.startedAt;
        if (!startedAt) return;
        const update = () => setDisplayElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        update();
        const intervalId = window.setInterval(update, 1000);
        return () => window.clearInterval(intervalId);
    }, [isCurrentConvLoading, currentConvId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const textarea = document.getElementById('chat-input');
        if (!textarea) return;
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
    }, [input]);

    useEffect(() => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            setSpeechSupported(false);
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.lang = 'zh-TW';
        recognition.continuous = true;
        recognition.interimResults = true;

        recognition.onresult = (event) => {
            let interimTranscript = "";
            for (let i = event.resultIndex; i < event.results.length; i += 1) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    speechTranscriptRef.current += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }
            speechInterimRef.current = interimTranscript;
        };

        recognition.onerror = (event) => {
            // Only treat permission/device errors as fatal. `no-speech` fires
            // routinely during an ordinary thinking pause in continuous
            // dictation, and `network`/`aborted` are often transient — none
            // of those should discard everything already transcribed.
            // `onend` (which always fires after `onerror`) handles recovery.
            const isFatal = event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture';
            if (!isFatal) return;

            speechErrorRef.current = true;
            setIsListening(false);
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: '⚠️ Microphone permission was blocked. Please allow microphone access in your browser settings.'
                }]);
            }
        };

        recognition.onend = () => {
            if (!speechErrorRef.current && !speechDiscardRef.current) {
                const baseText = speechBaseInputRef.current.trim();
                const spokenText = `${speechTranscriptRef.current}${speechInterimRef.current}`.trim();
                if (spokenText) {
                    setInput([baseText, spokenText].filter(Boolean).join(baseText ? " " : ""));
                }
            }
            speechInterimRef.current = "";

            // Chrome silently ends recognition on its own after a brief pause
            // even with continuous=true (typically preceded by a `no-speech`
            // error). Restart automatically as long as the user hasn't
            // stopped/cancelled/confirmed — speechTranscriptRef keeps
            // accumulating across restarts, so this is what actually makes
            // "continuous" dictation continuous instead of truncating at the
            // first pause.
            if (!speechErrorRef.current && !speechDiscardRef.current && isListeningRef.current) {
                // 節流：3 秒內重啟超過 4 次視為異常迴圈（常見於手機瀏覽器
                // 音訊 session 反覆立即結束），放棄自動重啟、跳提示，而不是
                // 讓 start()/onend() 緊密循環佔滿主執行緒。
                const now = Date.now();
                const recentRestarts = speechRestartTimestampsRef.current.filter(ts => now - ts < 3000);
                recentRestarts.push(now);
                speechRestartTimestampsRef.current = recentRestarts;

                if (recentRestarts.length <= 4) {
                    // 短延遲再重啟，而不是同步立即呼叫：手機上 onend 觸發時，
                    // 音訊管線往往還沒釋放乾淨，立刻 start() 容易再次立即
                    // onend，正是緊密迴圈的成因。
                    speechRestartTimeoutRef.current = window.setTimeout(() => {
                        speechRestartTimeoutRef.current = null;
                        if (!isListeningRef.current) return;
                        try {
                            recognition.start();
                        } catch (error) {
                            console.error("Speech recognition restart failed:", error);
                            speechErrorRef.current = false;
                            speechDiscardRef.current = false;
                            setIsListening(false);
                        }
                    }, 120);
                    return;
                }

                console.error("Speech recognition restarted too many times in a row; giving up.");
                speechRestartTimestampsRef.current = [];
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: '⚠️ Voice input was unstable and had to stop. Please try again.'
                }]);
            }

            speechRestartTimestampsRef.current = [];
            speechErrorRef.current = false;
            speechDiscardRef.current = false;
            setIsListening(false);
        };

        recognitionRef.current = recognition;

        return () => {
            if (speechRestartTimeoutRef.current) {
                window.clearTimeout(speechRestartTimeoutRef.current);
                speechRestartTimeoutRef.current = null;
            }
            recognition.stop();
            recognitionRef.current = null;
        };
    }, []);

    // ── 對話管理 ─────────────────────────────────────────
    const startNewConversation = () => {
        // Do NOT abort the clarification request here. If a clarification is
        // in-flight for the previous conversation, let it complete in the
        // background. handleSubmit will detect the conversation switch and
        // skip the clarification panel, sending the chat directly so the user
        // gets a response when they return to that conversation.
        if (clarifyingConvId) {
            setClarifyingConvId(null);
        }
        if (clarification) {
            clearClarification();
        }
        const newId = generateId();
        pendingScrollBehaviorRef.current = "auto";
        currentConvIdRef.current = newId;
        messagesRef.current = [];
        setCurrentConvId(newId);
        setMessages([]);
        setShowMeetingsPage(false);
        setShowActionBoard(false);
    };

    const switchConversation = (conv) => {
        // Same as startNewConversation: don't abort in-flight requests when
        // the user switches away. The previous conversation continues in the
        // background and will show the response when the user returns.
        if (clarifyingConvId) {
            setClarifyingConvId(null);
        }
        if (clarification) {
            clearClarification();
        }
        pendingScrollBehaviorRef.current = "auto";
        currentConvIdRef.current = conv.id;
        messagesRef.current = conv.messages;
        setCurrentConvId(conv.id);
        setMessages(conv.messages);
        setShowMeetingsPage(false);
        setShowActionBoard(false);
    };

    const openConvSearch = () => {
        setShowConvSearch(true);
        setConvSearchQuery('');
        setConvSearchActiveIndex(0);
    };

    const closeConvSearch = () => {
        setShowConvSearch(false);
    };

    const selectConvFromSearch = (conv) => {
        switchConversation(conv);
        closeConvSearch();
    };

    // Matches title OR any message's content (not just the title, unlike the
    // plain sidebar list) — same pinned-then-recency ordering as the sidebar
    // when the query is empty, so opening the panel shows something useful
    // before typing anything, the same way Claude's search does.
    const convSearchResults = useMemo(() => {
        const sorted = conversations.slice().sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
        });
        const query = convSearchQuery.trim().toLowerCase();
        if (!query) return sorted.map((conv) => ({ conv, snippet: null }));

        const results = [];
        for (const conv of sorted) {
            if ((conv.title || '').toLowerCase().includes(query)) {
                results.push({ conv, snippet: null });
                continue;
            }
            const hit = (conv.messages || []).find((m) => (m.content || '').toLowerCase().includes(query));
            if (hit) results.push({ conv, snippet: buildMatchSnippet(hit.content, query) });
        }
        return results;
    }, [conversations, convSearchQuery]);

    useEffect(() => {
        setConvSearchActiveIndex(0);
    }, [convSearchQuery]);

    useEffect(() => {
        if (showConvSearch) convSearchInputRef.current?.focus();
    }, [showConvSearch]);

    const handleConvSearchKeyDown = (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setConvSearchActiveIndex((i) => Math.min(i + 1, convSearchResults.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setConvSearchActiveIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const result = convSearchResults[convSearchActiveIndex];
            if (result) selectConvFromSearch(result.conv);
        } else if (e.key === 'Escape') {
            closeConvSearch();
        }
    };

    // Shared by the header's key button and MeetingRecordsPage's proactive
    // prompt (opened when someone tries to record without a Groq key set),
    // so both entry points open the modal pre-filled with the current keys.
    const openApiKeysModal = () => {
        setApiKeyInput(geminiApiKey);
        setGroqApiKeyInput(groqApiKey);
        setShowApiKeyModal(true);
    };

    // Saves whichever of the two API key drafts is non-empty and closes the
    // modal — shared by the Save button and pressing Enter in either field.
    const commitApiKeys = () => {
        const geminiTrimmed = apiKeyInput.trim();
        if (geminiTrimmed) {
            localStorage.setItem(GEMINI_KEY_STORAGE, geminiTrimmed);
            setGeminiApiKey(geminiTrimmed);
        }
        const groqTrimmed = groqApiKeyInput.trim();
        if (groqTrimmed) {
            localStorage.setItem(GROQ_KEY_STORAGE, groqTrimmed);
            setGroqApiKey(groqTrimmed);
        }
        setShowApiKeyModal(false);
        setApiKeyVisible(false);
        setGroqApiKeyVisible(false);
    };

    // Shared by single-conversation delete (three-dot menu) and bulk delete
    // (select mode). Takes a Set of conversation ids to remove.
    const deleteConversationsByIds = (convIds) => {
        convIds.forEach(convId => {
            const ctrl = abortControllersRef.current.get(convId);
            if (ctrl) { ctrl.abort(); abortControllersRef.current.delete(convId); }
            if (clarifyingConvId === convId) {
                clarificationAbortRef.current?.abort();
                clarificationAbortRef.current = null;
                setClarifyingConvId(null);
            }
        });
        setConvStatuses(prev => {
            const n = { ...prev };
            convIds.forEach(id => delete n[id]);
            return n;
        });
        setLoadingConvIds(prev => {
            const n = new Set(prev);
            convIds.forEach(id => n.delete(id));
            return n;
        });
        const updated = conversations.filter(c => !convIds.has(c.id));
        saveConversations(updated);
        setConversations(updated);

        if (convIds.has(currentConvId)) {
            if (updated.length > 0) {
                pendingScrollBehaviorRef.current = "auto";
                currentConvIdRef.current = updated[0].id;
                messagesRef.current = updated[0].messages;
                setCurrentConvId(updated[0].id);
                setMessages(updated[0].messages);
            } else {
                startNewConversation();
            }
        }
    };

    const deleteConversation = (e, convId) => {
        e.stopPropagation();
        deleteConversationsByIds(new Set([convId]));
    };

    const toggleConvSelectMode = () => {
        setIsSelectingConvs(prev => !prev);
        setSelectedConvIds(new Set());
        setOpenMenuConvId(null);
    };

    const toggleConvSelection = (convId) => {
        setSelectedConvIds(prev => {
            const n = new Set(prev);
            if (n.has(convId)) n.delete(convId); else n.add(convId);
            return n;
        });
    };

    const toggleSelectAllConvs = () => {
        setSelectedConvIds(prev =>
            prev.size === conversations.length && conversations.length > 0
                ? new Set()
                : new Set(conversations.map(c => c.id))
        );
    };

    const deleteSelectedConversations = () => {
        if (selectedConvIds.size === 0) return;
        if (!confirm(`Are you sure you want to delete ${selectedConvIds.size} conversation(s)?`)) return;
        deleteConversationsByIds(selectedConvIds);
        setSelectedConvIds(new Set());
        setIsSelectingConvs(false);
    };

    const pinConversation = (e, convId) => {
        e.stopPropagation();
        setConversations(prev => {
            const updated = prev.map(c => c.id === convId ? { ...c, pinned: !c.pinned } : c);
            conversationsRef.current = updated;
            saveConversations(updated);
            return updated;
        });
    };

    const startRenameConv = (e, convId, currentTitle) => {
        e.stopPropagation();
        setRenamingConvId(convId);
        setRenamingConvTitle(currentTitle);
    };

    const confirmRenameConv = (convId) => {
        const trimmed = renamingConvTitle.trim();
        setRenamingConvId(null);
        if (!trimmed) return;
        setConversations(prev => {
            const updated = prev.map(c => c.id === convId ? { ...c, title: trimmed, autoTitle: false } : c);
            conversationsRef.current = updated;
            saveConversations(updated);
            return updated;
        });
    };

    // ── 文件管理 ─────────────────────────────────────────
    const toggleDocumentSelection = (doc) => {
        const newSelected = new Set(selectedDocuments);
        if (newSelected.has(doc)) {
            newSelected.delete(doc);
        } else {
            newSelected.add(doc);
        }
        setSelectedDocuments(newSelected);
    };

    const toggleSelectAll = () => {
        if (selectedDocuments.size === documents.length && documents.length > 0) {
            setSelectedDocuments(new Set());
        } else {
            setSelectedDocuments(new Set(documents));
        }
    };

    // ── 會議記錄上下文管理（比照上面的文件管理，checkbox 只決定「這輪對話
    // 要不要把這筆會議記錄的內容送給 AI」，跟 Meeting Records 頁面本身的
    // 新增/刪除是分開的）─────────────────────────────────
    const toggleMeetingSelection = (meetingId) => {
        setSelectedMeetings(prev => {
            const next = new Set(prev);
            if (next.has(meetingId)) next.delete(meetingId); else next.add(meetingId);
            return next;
        });
    };

    const toggleSelectAllMeetings = () => {
        if (selectedMeetings.size === meetingRecords.length && meetingRecords.length > 0) {
            setSelectedMeetings(new Set());
        } else {
            setSelectedMeetings(new Set(meetingRecords.map(r => r.meeting_id)));
        }
    };

    // 送出聊天訊息前呼叫：把目前勾選的會議記錄從 IndexedDB 讀出完整內容
    // （listMeetingRecords 只回傳摘要清單，agenda/actions 等欄位要另外
    // 讀），格式化成純文字後跟著這輪請求送給後端。
    const buildActiveMeetingsPayload = async () => {
        if (selectedMeetings.size === 0) return [];
        const results = await Promise.all([...selectedMeetings].map(async (meetingId) => {
            const record = await getMeetingRecord(meetingId);
            if (!record) return null;
            const content = formatMeetingRecordForContext(record);
            if (!content) return null;
            return { title: record.meeting_data?.meeting_title || 'Meeting Notes', content };
        }));
        return results.filter(Boolean);
    };

    // 勾選變動時重新估算總字數，供側欄的「選太多」提示使用（見下面的
    // ACTIVE_MEETINGS_WARN_CHAR_THRESHOLD）。跟 buildActiveMeetingsPayload
    // 送出時做的事一樣，只是這裡是提前預覽，不是真的要送出。
    useEffect(() => {
        if (selectedMeetings.size === 0) {
            setActiveMeetingsCharCount(0);
            return;
        }
        let cancelled = false;
        buildActiveMeetingsPayload().then((payload) => {
            if (cancelled) return;
            setActiveMeetingsCharCount(payload.reduce((sum, m) => sum + m.content.length, 0));
        });
        return () => { cancelled = true; };
        // buildActiveMeetingsPayload is recreated every render; including it
        // here would refire this effect every render (it reads IndexedDB and
        // calls setState), which is exactly the loop this dep list avoids.
    }, [selectedMeetings]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Bulk-select-to-delete for Sources (separate from the "active for
    // conversation" checkboxes above — mirrors the Conversations select-mode) ──
    const toggleDocsSelectMode = () => {
        setIsSelectingDocs(prev => !prev);
        setSelectedDocIdsForDelete(new Set());
    };

    const toggleDocIdForDelete = (doc) => {
        setSelectedDocIdsForDelete(prev => {
            const n = new Set(prev);
            if (n.has(doc)) n.delete(doc); else n.add(doc);
            return n;
        });
    };

    const toggleSelectAllDocsForDelete = () => {
        setSelectedDocIdsForDelete(prev =>
            prev.size === documents.length && documents.length > 0
                ? new Set()
                : new Set(documents)
        );
    };

    const deleteSelectedDocs = async () => {
        if (selectedDocIdsForDelete.size === 0) return;
        if (!confirm(`Are you sure you want to delete ${selectedDocIdsForDelete.size} file(s)?`)) return;

        const toDelete = [...selectedDocIdsForDelete];

        setDocuments(prev => prev.filter(doc => !toDelete.includes(doc)));
        setSelectedDocIdsForDelete(new Set());
        setIsSelectingDocs(false);

        for (const filename of toDelete) {
            try {
                await axios.delete(`${API_URL}/documents/${encodeURIComponent(filename)}`);
            } catch (error) {
                console.error("Delete failed:", error);
            }
        }

        await fetchDocuments();
    };

    const deleteDocument = async (filename) => {
        if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;
        setDocuments(prev => prev.filter(doc => doc !== filename));
        setSelectedDocuments(prev => { const n = new Set(prev); n.delete(filename); return n; });
        try {
            await axios.delete(`${API_URL}/documents/${encodeURIComponent(filename)}`);
            await fetchDocuments();
        } catch (error) {
            console.error("Delete failed:", error);
            await fetchDocuments();
        }
    };

    const startRename = (doc) => {
        setRenamingDoc(doc);
        setNewDocName(doc.replace('.pdf', ''));
    };

    const confirmRename = async () => {
        if (!newDocName.trim()) return;
        try {
            await axios.put(`${API_URL}/documents/${encodeURIComponent(renamingDoc)}`, { new_name: newDocName });
            setSelectedDocuments(prev => {
                if (!prev.has(renamingDoc)) return prev;
                const n = new Set(prev);
                n.delete(renamingDoc);
                n.add(`${newDocName}.pdf`);
                return n;
            });
            await fetchDocuments();
            setRenamingDoc(null);
            setNewDocName("");
        } catch (error) {
            console.error("Rename failed:", error);
            alert(`Rename failed: ${error.message}`);
        }
    };

    const handleFileUpload = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        setUploadProgress(0);
        setUploadStage("Uploading file...");
        let hadError = false;
        const formData = new FormData();
        formData.append("file", file);
        if (geminiApiKey) formData.append("gemini_api_key", geminiApiKey);

        try {
            const res = await axios.post(`${API_URL}/upload`, formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                onUploadProgress: (e) => {
                    const pct = Math.round((e.loaded * 90) / e.total);
                    setUploadProgress(pct);
                    if (pct < 30) setUploadStage("Uploading file...");
                    else if (pct < 70) setUploadStage("Transferring data...");
                    else setUploadStage("File received, processing...");
                },
            });
            setUploadProgress(95);
            setUploadStage("Building knowledge base...");
            await fetchDocuments();
            setUploadProgress(100);
            if (res.data?.warning === 'knowledge_base_not_built') {
                setUploadStage("Uploaded. Set your API key to enable PDF search.");
                hadError = true;
            } else {
                setUploadStage("Done!");
            }
            if (res.data?.filename) {
                setSelectedDocuments(prev => new Set([...prev, res.data.filename]));
            }
        } catch (error) {
            console.error("Upload failed", error);
            hadError = true;
            const detail = error.response?.data;
            const serverMsg = detail?.message || (typeof detail === 'string' ? detail : null);
            setUploadStage(serverMsg || "Upload failed. Please try again.");
            setUploadProgress(0);
        } finally {
            setTimeout(() => {
                setIsUploading(false);
                setUploadProgress(0);
                setUploadStage("");
                if (fileInputRef.current) fileInputRef.current.value = "";
            }, hadError ? 4000 : 800);
        }
    };

    const handleStop = (convId) => {
        const ctrl = abortControllersRef.current.get(convId);
        if (ctrl) { ctrl.abort(); abortControllersRef.current.delete(convId); }
        if (clarifyingConvId === convId) {
            clarificationAbortRef.current?.abort();
            clarificationAbortRef.current = null;
            setClarifyingConvId(null);
        }
        setConvStatuses(prev => { const n = { ...prev }; delete n[convId]; return n; });
        setLoadingConvIds(prev => { const n = new Set(prev); n.delete(convId); return n; });
    };

    const beginResponseStatus = (convId, phase = "understanding") => {
        setConvStatuses(prev => ({ ...prev, [convId]: { phase, statusText: '', startedAt: Date.now() } }));
    };

    const advanceResponseStatus = (convId, phase, label = "") => {
        setConvStatuses(prev => {
            if (!prev[convId]) return prev;
            return { ...prev, [convId]: { ...prev[convId], phase, statusText: label } };
        });
    };

    const endResponseStatus = (convId) => {
        setConvStatuses(prev => { const n = { ...prev }; delete n[convId]; return n; });
    };

    const makeProgressHandler = (convId) => (payload = {}) => {
        const phase = payload.phase || "thinking";
        const normalizedPhase = phase === "tool" ? "searching" : phase;
        setConvStatuses(prev => {
            if (!prev[convId]) return prev;
            let statusText = '';
            if (payload.label) {
                const translated = toEnglishUiText(payload.label);
                statusText = hasCjkText(translated) ? '' : translated;
            }
            return { ...prev, [convId]: { ...prev[convId], phase: normalizedPhase, statusText } };
        });
    };


    // 手動停止（切換、取消、確認）都要清掉待執行的自動重啟計時器，
    // 否則可能在使用者已經停止聽寫後又多重啟一次。
    const clearPendingSpeechRestart = () => {
        if (speechRestartTimeoutRef.current) {
            window.clearTimeout(speechRestartTimeoutRef.current);
            speechRestartTimeoutRef.current = null;
        }
        speechRestartTimestampsRef.current = [];
    };

    const toggleVoiceInput = () => {
        if (!speechSupported || !recognitionRef.current || isClarifyingCurrentConv) return;

        if (isListening) {
            clearPendingSpeechRestart();
            recognitionRef.current.stop();
            setIsListening(false);
            return;
        }

        speechBaseInputRef.current = input;
        speechTranscriptRef.current = "";
        speechInterimRef.current = "";
        speechErrorRef.current = false;
        speechDiscardRef.current = false;
        clearPendingSpeechRestart();
        try {
            recognitionRef.current.start();
            setIsListening(true);
        } catch (error) {
            console.error("Speech recognition failed:", error);
            setIsListening(false);
        }
    };

    const cancelVoiceInput = () => {
        if (!recognitionRef.current) return;
        clearPendingSpeechRestart();
        speechDiscardRef.current = true;
        recognitionRef.current.stop();
        setIsListening(false);
    };

    const confirmVoiceInput = () => {
        if (!recognitionRef.current) return;
        clearPendingSpeechRestart();
        speechDiscardRef.current = false;
        recognitionRef.current.stop();
        setIsListening(false);
    };

    // 答案不再逐字串流：後端要等生成＋查核／存檔全部跑完，才把最終（已查核）
    // 全文透過 final 事件一次送到前端（見 agent_logic.py 的說明）。這裡純粹
    // 用前端動畫把已經確定的全文「假打字」出來，讓畫面還是有逐字浮現的感覺，
    // 但不會出現「文字顯示完了，畫面卻還在轉」的矛盾狀態，也不會讓使用者
    // 看到一版之後又被查核悄悄改寫的答案。signal.aborted（使用者按 Stop）
    // 時直接跳到全文，讓呼叫端接著收尾。
    const animateAssistantReply = (convId, fullText, signal) => new Promise((resolve) => {
        if (!fullText) { resolve(); return; }
        const TICK_MS = 24;
        const totalMs = Math.min(1400, Math.max(300, fullText.length * 6));
        const ticks = Math.max(1, Math.round(totalMs / TICK_MS));
        const charsPerTick = Math.max(1, Math.ceil(fullText.length / ticks));
        let shown = 0;

        const step = () => {
            if (signal.aborted) { resolve(); return; }
            shown = Math.min(fullText.length, shown + charsPerTick);
            const contentNow = fullText.slice(0, shown);
            updateConversationMessages(convId, prev => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'assistant' && last.streaming) {
                    return [...prev.slice(0, -1), { ...last, content: contentNow }];
                }
                return [...prev, { role: 'assistant', content: contentNow, streaming: true }];
            });
            if (shown >= fullText.length) { resolve(); return; }
            setTimeout(step, TICK_MS);
        };
        step();
    });

    const sendChatMessage = async (
        messageContent,
        activeConvId,
        historySnapshot,
        clarifications = [],
        appendUserMessage = true,
        statusPhase = "searching",
        turnContext = {}
    ) => {
        if (appendUserMessage) {
            updateConversationMessages(activeConvId, prev => [...prev, { role: 'user', content: messageContent }]);
        }
        setInput("");
        beginResponseStatus(activeConvId, statusPhase);
        setLoadingConvIds(prev => new Set([...prev, activeConvId]));

        const controller = new AbortController();
        abortControllersRef.current.set(activeConvId, controller);

        try {
            const activeMeetings = await buildActiveMeetingsPayload();
            const response = await streamChat({
                message: messageContent,
                history: historySnapshot,
                conversation_id: activeConvId,
                clarifications,
                turn_context: turnContext,
                active_documents: [...selectedDocuments],
                active_meetings: activeMeetings,
            }, controller.signal, makeProgressHandler(activeConvId), geminiApiKey || undefined);

            await animateAssistantReply(activeConvId, response.response || '', controller.signal);

            updateConversationMessages(activeConvId, prev => {
                const base = prev.length && prev[prev.length - 1].streaming ? prev.slice(0, -1) : prev;
                return [...base, {
                    role: 'assistant',
                    content: response.response,
                    metadata: response.metadata || {},
                    errorCode: response.error_code || null,
                }];
            });
        } catch (error) {
            if (axios.isCancel(error) || error.code === 'ERR_CANCELED' || error.name === 'AbortError') {
                return;
            }
            console.error("Error:", error);
            updateConversationMessages(activeConvId, prev => [...prev, {
                role: 'assistant',
                content: buildRequestErrorMessage(error, statusPhase === "regenerating" ? 'regenerate' : 'chat', messageContent)
            }]);
        } finally {
            abortControllersRef.current.delete(activeConvId);
            endResponseStatus(activeConvId);
            setLoadingConvIds(prev => { const n = new Set(prev); n.delete(activeConvId); return n; });
        }
    };

    const buildClarificationSelections = () => {
        // 複選：一題可以有多個選取值，每個值各自變成一筆 selection，
        // 後端會把它們並列成多個查詢條件（例如同時依狀態＋依市場分析）。
        return (clarification?.questions || []).flatMap((question) => {
            const selectedValues = clarificationAnswers[question.id] || [];
            return selectedValues.map((selectedValue) => {
                if (selectedValue === '__custom__') {
                    const customValue = (clarificationCustomAnswers[question.id] || '').trim();
                    if (!customValue) return null;
                    return {
                        question: question.question,
                        label: 'Custom',
                        value: customValue,
                    };
                }
                const selectedOption = question.options.find(option => option.value === selectedValue);
                if (!selectedOption) return null;
                return {
                    question: question.question,
                    label: selectedOption.label,
                    value: selectedOption.value,
                };
            }).filter(Boolean);
        });
    };

    const clearClarification = () => {
        setClarification(null);
        setClarificationAnswers({});
        setClarificationCustomAnswers({});
        setPendingMessage("");
        setPendingHistorySnapshot([]);
        setPendingTurnContext({});
        setPendingConversationId(null);
    };

    const confirmClarification = async () => {
        if (!pendingMessage || isCurrentConvLoading) return;
        const activeConvId = pendingConversationId || currentConvId || generateId();
        if (!currentConvId) {
            currentConvIdRef.current = activeConvId;
            setCurrentConvId(activeConvId);
        }
        const clarificationSelections = buildClarificationSelections();
        const historySnapshot = pendingHistorySnapshot;
        const turnContext = pendingTurnContext;
        const messageToSend = pendingMessage;
        clearClarification();
        await sendChatMessage(messageToSend, activeConvId, historySnapshot, clarificationSelections, false, "searching", turnContext);
    };

    const skipClarification = async () => {
        if (!pendingMessage || isCurrentConvLoading) return;
        const activeConvId = pendingConversationId || currentConvId || generateId();
        if (!currentConvId) {
            currentConvIdRef.current = activeConvId;
            setCurrentConvId(activeConvId);
        }
        const messageToSend = pendingMessage;
        const historySnapshot = pendingHistorySnapshot;
        const turnContext = pendingTurnContext;
        clearClarification();
        await sendChatMessage(messageToSend, activeConvId, historySnapshot, [], false, "searching", turnContext);
    };

    // ── 聊天邏輯 ─────────────────────────────────────────
    const handleSubmit = async (e) => {
        if (e) e.preventDefault();
        if (!input.trim() || isCurrentConvLoading || isClarifyingCurrentConv) return;

        const textarea = document.getElementById('chat-input');
        if (isListening && recognitionRef.current) {
            recognitionRef.current.stop();
            setIsListening(false);
            return;
        }

        const activeConvId = currentConvId || generateId();
        if (!currentConvId) {
            currentConvIdRef.current = activeConvId;
            setCurrentConvId(activeConvId);
        }

        const messageContent = input.trim();
        const historySnapshot = messages;
        const userMessage = { role: 'user', content: messageContent };

        updateConversationMessages(activeConvId, prev => [...prev, userMessage]);
        setInput("");
        if (textarea) textarea.style.height = 'auto';
        beginResponseStatus(activeConvId, "understanding");
        setLoadingConvIds(prev => new Set([...prev, activeConvId]));
        setClarifyingConvId(activeConvId);

        const clarAbort = new AbortController();
        clarificationAbortRef.current = clarAbort;

        let turnContext = {};
        try {
            const clarificationResponse = await axios.post(`${API_URL}/clarifications`, {
                message: messageContent,
                history: historySnapshot,
                conversation_id: activeConvId,
                active_documents: [...selectedDocuments],
                ...(geminiApiKey ? { gemini_api_key: geminiApiKey } : {}),
            }, { signal: clarAbort.signal });
            turnContext = clarificationResponse.data?.turn_context || {};

            if (clarificationResponse.data?.needs_clarification && clarificationResponse.data?.questions?.length > 0) {
                // Only show the clarification panel if the user is still viewing
                // this conversation. If they switched away, skip the panel and
                // let the chat continue in the background without clarification.
                if (currentConvIdRef.current === activeConvId) {
                    const nextClarification = clarificationResponse.data;
                    // 複選：每題的答案是 value 陣列，預設勾選第一個選項。
                    const defaultAnswers = {};
                    nextClarification.questions.forEach((question) => {
                        if (question.options?.[0]) defaultAnswers[question.id] = [question.options[0].value];
                    });
                    setPendingMessage(messageContent);
                    setPendingHistorySnapshot(historySnapshot);
                    setPendingTurnContext(turnContext);
                    setPendingConversationId(activeConvId);
                    setClarification(nextClarification);
                    setClarificationAnswers(defaultAnswers);
                    setClarificationCustomAnswers({});
                    setInput("");
                    endResponseStatus(activeConvId);
                    setLoadingConvIds(prev => { const n = new Set(prev); n.delete(activeConvId); return n; });
                    return;
                }
                // User switched away — fall through to sendChatMessage without clarification
            }
        } catch (error) {
            if (error.name === 'AbortError' || axios.isCancel(error)) {
                // Only reaches here when the user explicitly clicked Stop (handleStop).
                // startNewConversation/switchConversation no longer abort the clarification.
                endResponseStatus(activeConvId);
                setLoadingConvIds(prev => { const n = new Set(prev); n.delete(activeConvId); return n; });
                return;
            }
            console.error("Clarification check failed:", error);
        } finally {
            clarificationAbortRef.current = null;
            setClarifyingConvId(null);
        }

        advanceResponseStatus(activeConvId, "searching");
        await sendChatMessage(messageContent, activeConvId, historySnapshot, [], false, "searching", turnContext);
    };

    const handleMessageUpdate = async (index, newContent) => {
        if (isCurrentConvLoading) return;
        const historyContext = messages.slice(0, index);
        const updatedUserMessage = { ...messages[index], content: newContent };
        updateConversationMessages(currentConvId, [...historyContext, updatedUserMessage]);
        await sendChatMessage(newContent, currentConvId, historyContext, [], false, "regenerating");
    };

    const storageUsageRatio = storageEstimate?.quota ? storageEstimate.usage / storageEstimate.quota : 0;
    const isStorageBarExpanded = storageUsageRatio >= STORAGE_BAR_EXPAND_THRESHOLD;
    const isStorageNearFull = storageUsageRatio > 0.85;

    // ── Render ────────────────────────────────────────────
    return (
        <div className="flex h-screen bg-white">

            {/* Mobile backdrop */}
            {!isSidebarCollapsed && (
                <div
                    className="fixed inset-0 bg-black/30 z-20 md:hidden"
                    onClick={() => setIsSidebarCollapsed(true)}
                />
            )}

            {/* ── Sidebar ── */}
            <aside className={`
                ${isSidebarCollapsed ? '-translate-x-full md:translate-x-0 md:w-0' : 'translate-x-0 w-80'}
                fixed md:relative z-30 md:z-auto h-full
                bg-[#F5F5F5] border-r border-[#DFDFDF] flex flex-col
                transition-all duration-300 overflow-hidden
            `}>

                {/* Sidebar Header */}
                <div className="h-[72px] flex items-center justify-between px-4 border-b border-[#DFDFDF] flex-shrink-0">
                    <h2 className="text-base font-semibold text-[#111111]">Workspace</h2>
                    <button
                        onClick={() => setIsSidebarCollapsed(true)}
                        className="p-2 hover:bg-[#DFDFDF] rounded-full transition-colors"
                        aria-label="Collapse sidebar"
                        title="Collapse sidebar"
                    >
                        <ChevronLeft className="w-5 h-5 text-[#111111]" />
                    </button>
                </div>

                {/* New Chat Button */}
                <div className="px-4 pt-4 pb-2 flex-shrink-0">
                    <button
                        onClick={startNewConversation}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0058A3] hover:bg-[#004F93] text-white rounded-lg transition-colors text-sm font-medium"
                    >
                        <PenSquare className="w-4 h-4" />
                        New Chat
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto">

                    {/* ── Conversations Section ── */}
                    <div className="px-4 pb-2">
                        <div className="flex items-center justify-between py-2">
                            <span className="text-xs font-semibold text-[#767676] tracking-widest uppercase">Conversations</span>
                            <div className="flex items-center gap-1">
                                {conversations.length > 0 && (
                                    <button
                                        onClick={openConvSearch}
                                        className="p-1 rounded text-[#767676] hover:bg-[#DFDFDF] transition-colors"
                                        title="Search conversations"
                                    >
                                        <Search className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                {conversations.length > 0 && (
                                    <button
                                        onClick={toggleConvSelectMode}
                                        className={`p-1 rounded transition-colors ${isSelectingConvs ? 'bg-[#0058A3] text-white' : 'text-[#767676] hover:bg-[#DFDFDF]'}`}
                                        title={isSelectingConvs ? 'Exit select mode' : 'Select conversations to delete'}
                                    >
                                        <CheckSquare className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                <button
                                    onClick={() => setIsConvsExpanded(!isConvsExpanded)}
                                    className="p-1 hover:bg-[#DFDFDF] rounded transition-colors"
                                    aria-label={isConvsExpanded ? 'Collapse conversations' : 'Expand conversations'}
                                    aria-expanded={isConvsExpanded}
                                >
                                    <ChevronDown className={`w-3.5 h-3.5 text-[#767676] transition-transform ${isConvsExpanded ? '' : '-rotate-90'}`} />
                                </button>
                            </div>
                        </div>

                        {isConvsExpanded && (
                            <>
                                {isSelectingConvs && conversations.length > 0 && (
                                    <div className="flex items-center justify-between mb-1 px-2">
                                        <button
                                            onClick={toggleSelectAllConvs}
                                            className="flex items-center gap-2 hover:bg-white rounded py-1 transition-colors"
                                        >
                                            <div className={`w-3.5 h-3.5 rounded border-2 flex-shrink-0 ${selectedConvIds.size === conversations.length && conversations.length > 0 ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center`}>
                                                {selectedConvIds.size === conversations.length && conversations.length > 0 && <Check className="w-2.5 h-2.5 text-white" />}
                                            </div>
                                            <span className="text-xs text-[#767676]">
                                                {selectedConvIds.size === 0 ? 'Select all' : `${selectedConvIds.size} / ${conversations.length} selected`}
                                            </span>
                                        </button>
                                        <div className="flex items-center gap-1">
                                            <button
                                                onClick={deleteSelectedConversations}
                                                disabled={selectedConvIds.size === 0}
                                                className="p-1 hover:bg-red-100 rounded disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                                                title="Delete selected"
                                            >
                                                <Trash2 className="w-3.5 h-3.5 text-red-500" />
                                            </button>
                                            <button
                                                onClick={toggleConvSelectMode}
                                                className="p-1 hover:bg-[#DFDFDF] rounded transition-colors"
                                                title="Cancel"
                                            >
                                                <X className="w-3.5 h-3.5 text-[#767676]" />
                                            </button>
                                        </div>
                                    </div>
                                )}
                                <div className="max-h-[280px] overflow-y-auto -mr-1 pr-1">
                                    <div className="space-y-0.5">
                                        {conversations.length === 0 ? (
                                            <p className="text-sm text-[#767676] text-center py-4">No conversations yet</p>
                                        ) : (
                                            conversations
                                                .slice()
                                                .sort((a, b) => {
                                                    if (a.pinned && !b.pinned) return -1;
                                                    if (!a.pinned && b.pinned) return 1;
                                                    return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
                                                })
                                                .map(conv => {
                                                    const isLoading = loadingConvIds.has(conv.id);
                                                    const isActive = conv.id === currentConvId;
                                                    const isSelected = selectedConvIds.has(conv.id);
                                                    return (
                                                        <div
                                                            key={conv.id}
                                                            onClick={() => isSelectingConvs ? toggleConvSelection(conv.id) : switchConversation(conv)}
                                                            className={`group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors ${(isActive && !isSelectingConvs) || isSelected ? 'bg-white' : 'hover:bg-white'} ${conv.pinned ? 'border-l-2 border-[#0058A3]' : ''}`}
                                                        >
                                                            {/* Icon: checkbox (select mode) → loading spinner → pin → chat bubble */}
                                                            {isSelectingConvs ? (
                                                                <div className={`w-3.5 h-3.5 rounded border-2 flex-shrink-0 ${isSelected ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center`}>
                                                                    {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                                                                </div>
                                                            ) : isLoading ? (
                                                                <Loader2 className="w-3.5 h-3.5 flex-shrink-0 text-[#0058A3] animate-spin" />
                                                            ) : conv.pinned ? (
                                                                <Pin className="w-3.5 h-3.5 flex-shrink-0 text-[#0058A3]" />
                                                            ) : (
                                                                <MessageSquare className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-[#484848]' : 'text-[#767676]'}`} />
                                                            )}

                                                            <div className="flex-1 min-w-0">
                                                                <p className={`text-sm font-medium truncate ${isActive ? 'text-[#484848]' : 'text-[#111111]'}`}>
                                                                    {conv.title}
                                                                </p>
                                                                <p className="text-xs text-[#767676] mt-0.5">
                                                                    {isLoading ? (
                                                                        <span className="text-[#0058A3] font-medium">Responding…</span>
                                                                    ) : formatRelativeTime(conv.updatedAt || conv.createdAt)}
                                                                </p>
                                                            </div>

                                                            {/* Three-dot menu trigger (hidden while selecting) */}
                                                            {!isSelectingConvs && (
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        if (openMenuConvId === conv.id) { setOpenMenuConvId(null); return; }
                                                                        const rect = e.currentTarget.getBoundingClientRect();
                                                                        setMenuPosition({ top: rect.bottom + 4, left: rect.left - 128 });
                                                                        setOpenMenuConvId(conv.id);
                                                                    }}
                                                                    className={`flex-shrink-0 p-1 rounded transition-all hover:bg-[#DFDFDF] ${openMenuConvId === conv.id ? 'opacity-100 bg-[#DFDFDF]' : 'opacity-0 group-hover:opacity-100'}`}
                                                                    title="More options"
                                                                >
                                                                    <MoreHorizontal className="w-3.5 h-3.5 text-[#767676]" />
                                                                </button>
                                                            )}
                                                        </div>
                                                    );
                                                })
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Divider */}
                    <div className="mx-4 border-t border-[#DFDFDF] my-2" />

                    {/* ── Sources Section ── */}
                    <div className="px-4">
                        <div className="flex items-center justify-between py-2">
                            <span className="text-xs font-semibold text-[#767676] tracking-widest uppercase">Sources</span>
                            <div className="flex items-center gap-1">
                                {documents.length > 0 && (
                                    <button
                                        onClick={toggleDocsSelectMode}
                                        className={`p-1 rounded transition-colors ${isSelectingDocs ? 'bg-[#0058A3] text-white' : 'text-[#767676] hover:bg-[#DFDFDF]'}`}
                                        title={isSelectingDocs ? 'Exit select mode' : 'Select documents to delete'}
                                    >
                                        <CheckSquare className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                <button
                                    onClick={() => setIsSourcesExpanded(!isSourcesExpanded)}
                                    className="p-1 hover:bg-[#DFDFDF] rounded transition-colors"
                                    aria-label={isSourcesExpanded ? 'Collapse sources' : 'Expand sources'}
                                    aria-expanded={isSourcesExpanded}
                                >
                                    <ChevronDown className={`w-3.5 h-3.5 text-[#767676] transition-transform ${isSourcesExpanded ? '' : '-rotate-90'}`} />
                                </button>
                            </div>
                        </div>

                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isUploading}
                            className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-[#DFDFDF] rounded-lg hover:bg-white transition-colors text-sm font-medium text-[#484848] disabled:opacity-50 mb-2"
                        >
                            {isUploading ? (
                                <>
                                    <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                                    <span className="truncate">{uploadStage}</span>
                                </>
                            ) : (
                                <>
                                    <Plus className="w-3.5 h-3.5" />
                                    Add PDF Source
                                </>
                            )}
                        </button>

                        {isUploading && (
                            <div className="mt-2">
                                <div className="flex justify-between text-xs text-[#767676] mb-1">
                                    <span>{uploadStage}</span>
                                    <span>{uploadProgress}%</span>
                                </div>
                                <div className="w-full bg-[#DFDFDF] rounded-full h-1.5">
                                    <div
                                        className="bg-[#0058A3] h-1.5 rounded-full transition-all duration-300"
                                        style={{ width: `${uploadProgress}%` }}
                                    />
                                </div>
                            </div>
                        )}

                        <input type="file" accept=".pdf" onChange={handleFileUpload} style={{ display: 'none' }} ref={fileInputRef} />

                        {isSourcesExpanded && (
                            <div className="space-y-0.5">
                                {documents.length === 0 ? (
                                    <p className="text-sm text-[#767676] text-center py-4">No documents uploaded</p>
                                ) : (
                                    <>
                                        {isSelectingDocs ? (
                                            <div className="flex items-center justify-between mb-1 px-2">
                                                <button
                                                    onClick={toggleSelectAllDocsForDelete}
                                                    className="flex items-center gap-2 hover:bg-white rounded py-1 transition-colors"
                                                >
                                                    <div className={`w-3.5 h-3.5 rounded border-2 flex-shrink-0 ${selectedDocIdsForDelete.size === documents.length && documents.length > 0 ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center`}>
                                                        {selectedDocIdsForDelete.size === documents.length && documents.length > 0 && <Check className="w-2.5 h-2.5 text-white" />}
                                                    </div>
                                                    <span className="text-xs text-[#767676]">
                                                        {selectedDocIdsForDelete.size === 0 ? 'Select all' : `${selectedDocIdsForDelete.size} / ${documents.length} selected`}
                                                    </span>
                                                </button>
                                                <div className="flex items-center gap-1">
                                                    <button
                                                        onClick={deleteSelectedDocs}
                                                        disabled={selectedDocIdsForDelete.size === 0}
                                                        className="p-1 hover:bg-red-100 rounded disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                                                        title="Delete selected"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5 text-red-500" />
                                                    </button>
                                                    <button
                                                        onClick={toggleDocsSelectMode}
                                                        className="p-1 hover:bg-[#DFDFDF] rounded transition-colors"
                                                        title="Cancel"
                                                    >
                                                        <X className="w-3.5 h-3.5 text-[#767676]" />
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="flex items-center justify-between mb-1 px-2">
                                                <button
                                                    onClick={toggleSelectAll}
                                                    className="flex items-center gap-2 hover:bg-white rounded py-1 transition-colors"
                                                >
                                                    <div className={`w-3.5 h-3.5 rounded border-2 flex-shrink-0 ${selectedDocuments.size === documents.length && documents.length > 0 ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center`}>
                                                        {selectedDocuments.size === documents.length && documents.length > 0 && <Check className="w-2.5 h-2.5 text-white" />}
                                                    </div>
                                                    <span className="text-xs text-[#767676]">
                                                        {selectedDocuments.size === 0 ? 'Enable all' : `${selectedDocuments.size} / ${documents.length} active`}
                                                    </span>
                                                </button>
                                            </div>
                                        )}
                                        {documents.map((doc, idx) => {
                                            const isActive = selectedDocuments.has(doc);
                                            const isSelectedForDelete = selectedDocIdsForDelete.has(doc);
                                            return (
                                                <div
                                                    key={idx}
                                                    onClick={() => isSelectingDocs && toggleDocIdForDelete(doc)}
                                                    className={`flex items-center gap-2 p-2 rounded-lg hover:bg-white transition-colors group ${isSelectingDocs ? 'cursor-pointer' : ''}`}
                                                >
                                                    {isSelectingDocs ? (
                                                        <div className={`w-4 h-4 rounded border-2 flex-shrink-0 ${isSelectedForDelete ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center transition-colors`}>
                                                            {isSelectedForDelete && <Check className="w-2.5 h-2.5 text-white" />}
                                                        </div>
                                                    ) : (
                                                        <button
                                                            onClick={() => toggleDocumentSelection(doc)}
                                                            className="flex-shrink-0"
                                                            title={isActive ? 'Disable for conversation' : 'Enable for conversation'}
                                                        >
                                                            <div className={`w-4 h-4 rounded border-2 ${isActive ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center transition-colors`}>
                                                                {isActive && <Check className="w-2.5 h-2.5 text-white" />}
                                                            </div>
                                                        </button>
                                                    )}
                                                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                                                        <FileText className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-red-500' : 'text-[#CCCCCC]'}`} />
                                                        <span className={`text-sm truncate ${isActive ? 'text-[#111111]' : 'text-[#AAAAAA]'}`} title={doc}>{doc}</span>
                                                    </div>
                                                    {!isSelectingDocs && (
                                                        <div className="flex-shrink-0 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                                            <button onClick={() => startRename(doc)} className="p-1 hover:bg-[#DFDFDF] rounded" title="Rename">
                                                                <Edit2 className="w-3 h-3 text-[#484848]" />
                                                            </button>
                                                            <button onClick={() => deleteDocument(doc)} className="p-1 hover:bg-red-100 rounded" title="Delete">
                                                                <Trash2 className="w-3 h-3 text-red-500" />
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Divider */}
                    <div className="mx-4 border-t border-[#DFDFDF] my-2" />

                    {/* ── Meeting Records Section — same checkbox pattern as Sources
                        above, but toggles whether a meeting's organized minutes get
                        sent along as chat context, not whether it exists. Adding/
                        deleting records happens on the Meeting Records page itself. ── */}
                    <div className="px-4">
                        <div className="flex items-center justify-between py-2">
                            <span className="text-xs font-semibold text-[#767676] tracking-widest uppercase">Meeting Records</span>
                            <button
                                onClick={() => setIsMeetingSourcesExpanded(!isMeetingSourcesExpanded)}
                                className="p-1 hover:bg-[#DFDFDF] rounded transition-colors"
                                aria-label={isMeetingSourcesExpanded ? 'Collapse meeting records' : 'Expand meeting records'}
                                aria-expanded={isMeetingSourcesExpanded}
                            >
                                <ChevronDown className={`w-3.5 h-3.5 text-[#767676] transition-transform ${isMeetingSourcesExpanded ? '' : '-rotate-90'}`} />
                            </button>
                        </div>

                        {isMeetingSourcesExpanded && (
                            <div className="space-y-0.5">
                                {meetingRecords.length === 0 ? (
                                    <p className="text-sm text-[#767676] text-center py-4">No meeting records yet</p>
                                ) : (
                                    <>
                                        <div className="flex items-center justify-between mb-1 px-2">
                                            <button
                                                onClick={toggleSelectAllMeetings}
                                                className="flex items-center gap-2 hover:bg-white rounded py-1 transition-colors"
                                            >
                                                <div className={`w-3.5 h-3.5 rounded border-2 flex-shrink-0 ${selectedMeetings.size === meetingRecords.length && meetingRecords.length > 0 ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center`}>
                                                    {selectedMeetings.size === meetingRecords.length && meetingRecords.length > 0 && <Check className="w-2.5 h-2.5 text-white" />}
                                                </div>
                                                <span className="text-xs text-[#767676]">
                                                    {selectedMeetings.size === 0 ? 'Enable all' : `${selectedMeetings.size} / ${meetingRecords.length} active`}
                                                </span>
                                            </button>
                                        </div>
                                        {activeMeetingsCharCount > ACTIVE_MEETINGS_WARN_CHAR_THRESHOLD && (
                                            <p className="text-[10px] text-[#AAAAAA] px-2 mb-1 leading-snug">
                                                Selected meetings add ~{Math.round(activeMeetingsCharCount / 1000)}k characters to every message — consider selecting fewer for faster replies.
                                            </p>
                                        )}
                                        {meetingRecords.map((rec) => {
                                            const isActive = selectedMeetings.has(rec.meeting_id);
                                            const label = rec.meeting_title || 'Meeting Notes';
                                            return (
                                                <div key={rec.meeting_id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-white transition-colors group">
                                                    <button
                                                        onClick={() => toggleMeetingSelection(rec.meeting_id)}
                                                        className="flex-shrink-0"
                                                        title={isActive ? 'Disable for conversation' : 'Enable for conversation'}
                                                    >
                                                        <div className={`w-4 h-4 rounded border-2 ${isActive ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center transition-colors`}>
                                                            {isActive && <Check className="w-2.5 h-2.5 text-white" />}
                                                        </div>
                                                    </button>
                                                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                                                        <FileAudio className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-red-500' : 'text-[#CCCCCC]'}`} />
                                                        <div className="min-w-0 flex-1">
                                                            <p className={`text-sm truncate ${isActive ? 'text-[#111111]' : 'text-[#AAAAAA]'}`} title={label}>{label}</p>
                                                            {rec.date && <p className="text-[11px] text-[#AAAAAA] truncate">{rec.date}</p>}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                </div>

                <div className="p-3 border-t border-[#DFDFDF] flex-shrink-0">
                    {storageEstimate && (
                        isStorageBarExpanded ? (
                            <div className="mb-2">
                                <div className="flex justify-between text-[11px] text-[#767676] mb-1">
                                    <span>Browser storage</span>
                                    <span>{formatMb(storageEstimate.usage)} / {formatMb(storageEstimate.quota)}</span>
                                </div>
                                <div className="w-full bg-[#DFDFDF] rounded-full h-1.5">
                                    <div
                                        className={`h-1.5 rounded-full transition-all duration-300 ${isStorageNearFull ? 'bg-[#E00751]' : 'bg-[#0058A3]'}`}
                                        style={{ width: `${Math.max(2, Math.min(100, storageUsageRatio * 100))}%` }}
                                    />
                                </div>
                                <p className="text-[10px] text-[#AAAAAA] mt-1 leading-snug">
                                    Delete unused sources and old conversations to free up space.
                                </p>
                            </div>
                        ) : (
                            <div className="text-[11px] text-[#AAAAAA] text-center mb-1">
                                {formatMb(storageEstimate.usage)} browser storage used
                            </div>
                        )
                    )}
                    <div className="text-xs text-[#767676] text-center">Developed by IKEA Data Team</div>
                </div>
            </aside>

            {/* ── Main Content ── */}
            <div className="flex-1 flex flex-col min-w-0 bg-white">

                {/* Header */}
                <header className="bg-white min-h-[60px] sm:min-h-[84px] flex items-center shadow-sm border-b border-[#DFDFDF] flex-shrink-0">
                    <div className="max-w-4xl mx-auto w-full px-3 sm:px-6 py-2 sm:py-3 flex items-center justify-between gap-2">
                        {/* Sidebar opener docked in the header (desktop and mobile alike)
                            instead of a position:fixed button floating over the
                            conversation. Only needed while the sidebar is closed —
                            on mobile it's a full-screen overlay with its own close
                            button once open. */}
                        {isSidebarCollapsed && (
                            <button
                                type="button"
                                onClick={() => setIsSidebarCollapsed(false)}
                                className="flex-shrink-0 p-1.5 -ml-1 rounded-full hover:bg-[#F5F5F5] transition-colors"
                                aria-label="Open sidebar"
                                title="Open sidebar"
                            >
                                <Menu className="w-5 h-5 text-[#111111]" />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={startNewConversation}
                            className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1 text-left"
                            aria-label="Start a new conversation"
                            title="Start a new conversation"
                        >
                            {/* h-6/max-w on mobile keeps the logo from eating the width
                                the title and header icons need on narrow screens; it was
                                previously a fixed 36px on every breakpoint. */}
                            <img
                                src="https://www.inter.ikea.com/-/media/aboutikea/images/brand-default.svg?rev=23ee61ddbb1948f399b47938edeb3c11"
                                alt="IKEA Logo"
                                className="h-6 sm:h-9 w-auto max-w-[72px] sm:max-w-none flex-shrink-0 object-contain"
                            />
                            <div className="pl-2 sm:pl-4 border-l border-[#DFDFDF] min-w-0">
                                <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                                    <h1 className="text-base sm:text-2xl font-bold text-[#111111] leading-tight sm:leading-[1.67] truncate">Data Machi</h1>
                                    <span className="hidden sm:inline-flex rounded-full bg-[#DFDFDF] px-2 py-0.5 text-xs font-bold text-[#111111]">
                                        Beta
                                    </span>
                                </div>
                                <p className="text-[10px] sm:text-xs text-[#767676] font-medium tracking-wide truncate">Ask your data partner</p>
                            </div>
                        </button>
                        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
                            {SHOW_AI_DEBUG && (
                                <button
                                    onClick={() => setDebugMode(prev => !prev)}
                                    className={`p-1.5 sm:p-2 rounded-full transition-colors ${debugMode ? 'bg-[#F5F5F5]' : 'hover:bg-[#F5F5F5]'}`}
                                    title={debugMode ? "Hide AI debug" : "Show AI debug"}
                                    aria-pressed={debugMode}
                                >
                                    <Bug className="w-4 h-4 sm:w-5 sm:h-5 text-[#111111]" />
                                </button>
                            )}
                            {/* Meeting Records page entry */}
                            <button
                                onClick={() => {
                                    // Jump straight to the bottom (no animated scroll)
                                    // when coming back to chat, matching the "auto"
                                    // behavior used elsewhere for a freshly mounted view.
                                    if (showMeetingsPage) {
                                        pendingScrollBehaviorRef.current = "auto";
                                        setOpenMeetingId(null);
                                    }
                                    setShowActionBoard(false);
                                    setShowMeetingsPage((v) => !v);
                                }}
                                className={`p-1.5 sm:p-2 rounded-full transition-colors ${showMeetingsPage ? 'bg-[#F5F5F5]' : 'hover:bg-[#F5F5F5]'}`}
                                title="Meeting Records"
                                aria-pressed={showMeetingsPage}
                            >
                                <FileAudio className="w-4 h-4 sm:w-5 sm:h-5 text-[#111111]" />
                            </button>
                            {/* Action Items board entry */}
                            <button
                                onClick={() => {
                                    if (showActionBoard) pendingScrollBehaviorRef.current = "auto";
                                    setShowMeetingsPage(false);
                                    setOpenMeetingId(null);
                                    setShowActionBoard((v) => !v);
                                }}
                                className={`p-1.5 sm:p-2 rounded-full transition-colors ${showActionBoard ? 'bg-[#F5F5F5]' : 'hover:bg-[#F5F5F5]'}`}
                                title="Action Items"
                                aria-pressed={showActionBoard}
                            >
                                <Kanban className="w-4 h-4 sm:w-5 sm:h-5 text-[#111111]" />
                            </button>
                            {/* Clear / New chat button */}
                            {messages.length > 0 && (
                                <button
                                    onClick={startNewConversation}
                                    className="p-1.5 sm:p-2 hover:bg-[#F5F5F5] rounded-full transition-colors"
                                    title="Start new conversation"
                                >
                                    <PenSquare className="w-4 h-4 sm:w-5 sm:h-5 text-[#111111]" />
                                </button>
                            )}
                            <button
                                onClick={openApiKeysModal}
                                className="p-1.5 sm:p-2 rounded-full transition-colors relative hover:bg-[#F5F5F5]"
                                title={(geminiApiKey && groqApiKey) ? "API Keys configured" : "Set API Keys"}
                            >
                                <KeyRound className={`w-4 h-4 sm:w-5 sm:h-5 ${geminiApiKey ? 'text-[#0058A3]' : 'text-[#111111]'}`} />
                                {!(geminiApiKey && groqApiKey) && (
                                    <span className="absolute top-0.5 right-0.5 sm:top-1 sm:right-1 w-2 h-2 bg-amber-400 rounded-full" />
                                )}
                            </button>
                            <button
                                onClick={(e) => {
                                    if (showAvatarPicker) { setShowAvatarPicker(false); return; }
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const panelWidth = Math.min(320, window.innerWidth - 24);
                                    const left = Math.max(8, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 8));
                                    setAvatarPanelPosition({ top: rect.bottom + 8, left });
                                    setShowAvatarPicker(true);
                                }}
                                className="p-1.5 sm:p-2 hover:bg-[#F5F5F5] rounded-full transition-colors"
                                title="Change avatar"
                            >
                                <User className="w-4 h-4 sm:w-5 sm:h-5 text-[#111111]" />
                            </button>
                        </div>
                    </div>
                </header>

                {showMeetingsPage ? (
                    <Suspense fallback={
                        <div className="flex-1 flex items-center justify-center">
                            <Loader2 className="w-6 h-6 animate-spin text-[#0058A3]" />
                        </div>
                    }>
                        <MeetingRecordsPage apiUrl={API_URL} geminiApiKey={geminiApiKey} groqApiKey={groqApiKey} onOpenApiKeys={openApiKeysModal} initialMeetingId={openMeetingId} />
                    </Suspense>
                ) : showActionBoard ? (
                    <Suspense fallback={
                        <div className="flex-1 flex items-center justify-center">
                            <Loader2 className="w-6 h-6 animate-spin text-[#0058A3]" />
                        </div>
                    }>
                        <ActionItemsBoard
                            onOpenMeeting={(meetingId) => {
                                if (!meetingId) return;
                                pendingScrollBehaviorRef.current = "auto";
                                setShowActionBoard(false);
                                setOpenMeetingId(meetingId);
                                setShowMeetingsPage(true);
                            }}
                        />
                    </Suspense>
                ) : (
                <>
                {/* Chat Area */}
                <main className="flex-1 overflow-y-auto p-3 sm:p-6 bg-white">
                    {messages.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-center space-y-6 opacity-80">
                            <div className="bg-[#F5F5F5] p-6 rounded-full shadow-sm">
                                <Sparkles className="w-10 h-10 text-[#0058A3]" />
                            </div>
                            <div className="space-y-2">
                                <p className="text-2xl font-bold text-[#111111]">Hej! How can I help you today?</p>
                                <p className="text-sm text-[#767676] max-w-sm mx-auto leading-relaxed">
                                    Ask about "IKEA Data Requests", search Confluence docs, or check Trello status.
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="max-w-4xl mx-auto w-full flex flex-col gap-4">
                            {messages.map((msg, idx) => (
                                <ChatMessage
                                    key={idx}
                                    message={msg}
                                    userAvatar={userAvatar}
                                    debugMode={SHOW_AI_DEBUG && debugMode}
                                    onUpdate={(newContent) => handleMessageUpdate(idx, newContent)}
                                    onCopy={(content) => navigator.clipboard.writeText(content)}
                                />
                            ))}
                            {isCurrentConvLoading && !isStreamingAnswerVisible && (
                                <div className="flex justify-start">
                                    <div className="typing-indicator" role="status" aria-live="polite">
                                        <div className="typing-dots" aria-hidden="true">
                                            <div className="typing-dot"></div>
                                            <div className="typing-dot"></div>
                                            <div className="typing-dot"></div>
                                        </div>
                                        <div className="typing-status">
                                            <span>{responseStatusLabel}</span>
                                            <span>{displayElapsedSeconds}s</span>
                                        </div>
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </div>
                    )}
                </main>

                {/* Input */}
                <footer className="w-full max-w-4xl mx-auto px-2 sm:px-4 py-3 bg-white">
                    {clarification && pendingConversationId === currentConvId && (
                        <div className="clarification-panel">
                            <div className="clarification-panel-header">
                                <div>
                                    <p className="clarification-eyebrow">Help me aim better</p>
                                    <h2>
                                        {clarification.questions.length > 1
                                            ? "Help me narrow this down"
                                            : toEnglishUiText(clarification.questions[0]?.question)}
                                    </h2>
                                </div>
                                <button type="button" onClick={clearClarification} className="clarification-close" aria-label="Close clarification">
                                    ×
                                </button>
                            </div>
                            <div className="clarification-questions">
                                {clarification.questions.map((question, questionIndex) => {
                                    const questionId = question.id || `q${questionIndex + 1}`;
                                    const options = [...(question.options || []), {
                                        label: 'Custom',
                                        value: '__custom__',
                                        description: 'Add details in your own words'
                                    }];

                                    return (
                                        <section key={questionId} className="clarification-question">
                                            {clarification.questions.length > 1 && (
                                                <h3 className="clarification-question-title">{toEnglishUiText(question.question)}</h3>
                                            )}
                                            <div className="clarification-options">
                                                {options.map((option) => {
                                                    const selectedValues = clarificationAnswers[questionId] || [];
                                                    const isSelected = selectedValues.includes(option.value);
                                                    return (
                                                        <div key={`${questionId}-${option.value}`} className={`clarification-option-wrap ${isSelected ? 'selected' : ''}`}>
                                                            <button
                                                                type="button"
                                                                className={`clarification-option ${isSelected ? 'selected' : ''}`}
                                                                onClick={() => setClarificationAnswers(prev => {
                                                                    const current = prev[questionId] || [];
                                                                    const next = current.includes(option.value)
                                                                        ? current.filter((value) => value !== option.value)
                                                                        : [...current, option.value];
                                                                    return { ...prev, [questionId]: next };
                                                                })}
                                                            >
                                                                <span className="clarification-check">{isSelected ? '✓' : ''}</span>
                                                                <span>
                                                                    <strong>{toEnglishUiText(option.label)}</strong>
                                                                    {option.description && <small>{toEnglishUiText(option.description)}</small>}
                                                                </span>
                                                            </button>
                                                            {option.value === '__custom__' && isSelected && (
                                                                <input
                                                                    type="text"
                                                                    className="clarification-custom-input"
                                                                    value={clarificationCustomAnswers[questionId] || ''}
                                                                    onChange={(e) => setClarificationCustomAnswers(prev => ({ ...prev, [questionId]: e.target.value }))}
                                                                    placeholder="Enter any extra details"
                                                                    autoFocus
                                                                />
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    );
                                })}
                            </div>
                            <div className="clarification-actions">
                                <span>{toEnglishUiText(clarification.reason || 'Choose a direction and I will continue searching.')}</span>
                                <div>
                                    <button type="button" onClick={skipClarification} className="clarification-skip">Skip</button>
                                    <button type="button" onClick={confirmClarification} className="clarification-submit" aria-label="Continue">
                                        <ArrowUp />
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    <form
                        onSubmit={handleSubmit}
                        className={`chatbot-input-container ${isListening ? 'listening' : ''} ${input.trim() ? 'has-input' : ''}`}
                    >
                        {!input.trim() && !isListening && <Search className="input-leading-icon" aria-hidden="true" />}
                        <textarea
                            id="chat-input"
                            value={input}
                            onChange={(e) => {
                                setInput(e.target.value);
                                e.target.style.height = "auto";
                                e.target.style.height = `${e.target.scrollHeight}px`;
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                    e.preventDefault();
                                    handleSubmit(e);
                                }
                            }}
                            placeholder={isCurrentConvLoading || isClarifyingCurrentConv ? "Hold that thought!" : "Type your question here"}
                            disabled={isCurrentConvLoading || isClarifyingCurrentConv || (clarification && pendingConversationId === currentConvId)}
                            className="chatbot-input"
                            rows={1}
                        />
                        {isListening && (
                            <div className="voice-waveform" aria-hidden="true">
                                <span />
                                <span />
                                <span />
                                <span />
                                <span />
                                <span />
                                <span />
                            </div>
                        )}
                        <div className="input-actions">
                            {isCurrentConvLoading || isClarifyingCurrentConv ? (
                                <button type="button" onClick={() => handleStop(currentConvId)} className="stop-button" aria-label="Stop generation">
                                    <Square fill="currentColor" />
                                </button>
                            ) : isListening ? (
                                <>
                                    <button
                                        type="button"
                                        onClick={cancelVoiceInput}
                                        className="voice-action-button voice-cancel-button"
                                        aria-label="Cancel voice input"
                                        title="Cancel voice input"
                                    >
                                        <X />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={confirmVoiceInput}
                                        className="voice-action-button voice-confirm-button"
                                        aria-label="Confirm voice input"
                                        title="Confirm voice input"
                                    >
                                        <Check />
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        onClick={toggleVoiceInput}
                                        disabled={isClarifyingCurrentConv || !speechSupported}
                                        className={`mic-button ${isListening ? 'listening' : ''}`}
                                        aria-label={isListening ? "Stop voice input" : "Voice input"}
                                        title={!speechSupported ? "Voice input is not supported in this browser" : isListening ? "Stop voice input" : "Voice input"}
                                    >
                                        <Mic />
                                    </button>
                                    {input.trim() && (
                                        <button type="submit" disabled={isClarifyingCurrentConv} className="send-button" aria-label="Send message">
                                            <ArrowUp />
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    </form>
                    <div className="text-center mt-2 pb-2">
                        <p className="text-[10px] text-[#767676] font-medium">AI can make mistakes. Please verify important information.</p>
                    </div>
                </footer>
                </>
                )}
            </div>

            {/* ── Search Conversations Panel ── */}
            {showConvSearch && (
                <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 pt-24 px-4" onClick={closeConvSearch}>
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label="Search conversations"
                        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[70vh] flex flex-col overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#DFDFDF] flex-shrink-0">
                            <Search className="w-4 h-4 text-[#767676] flex-shrink-0" aria-hidden="true" />
                            <input
                                ref={convSearchInputRef}
                                type="text"
                                value={convSearchQuery}
                                onChange={(e) => setConvSearchQuery(e.target.value)}
                                onKeyDown={handleConvSearchKeyDown}
                                placeholder="Search conversations…"
                                className="flex-1 text-sm outline-none text-[#111111] placeholder:text-[#AAAAAA] bg-transparent"
                            />
                            <button onClick={closeConvSearch} className="p-1 hover:bg-[#F5F5F5] rounded-full transition-colors flex-shrink-0" aria-label="Close">
                                <X className="w-4 h-4 text-[#767676]" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto py-2">
                            {convSearchResults.length === 0 ? (
                                <p className="text-sm text-[#767676] text-center py-8">
                                    {convSearchQuery.trim() ? `No conversations found for "${convSearchQuery.trim()}"` : 'No conversations yet'}
                                </p>
                            ) : (
                                convSearchResults.map(({ conv, snippet }, index) => (
                                    <button
                                        key={conv.id}
                                        type="button"
                                        onClick={() => selectConvFromSearch(conv)}
                                        onMouseEnter={() => setConvSearchActiveIndex(index)}
                                        className={`w-full flex items-start gap-2.5 px-4 py-2.5 text-left transition-colors ${index === convSearchActiveIndex ? 'bg-[#F5F5F5]' : 'hover:bg-[#F5F5F5]'}`}
                                    >
                                        {conv.pinned ? (
                                            <Pin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-[#0058A3]" />
                                        ) : (
                                            <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-[#767676]" />
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-[#111111] truncate">{conv.title}</p>
                                            <p className="text-xs text-[#767676] mt-0.5 truncate">
                                                {snippet || formatRelativeTime(conv.updatedAt || conv.createdAt)}
                                            </p>
                                        </div>
                                    </button>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Rename Conversation Modal ── */}
            {renamingConvId && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setRenamingConvId(null)}>
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="rename-conv-heading"
                        className="bg-white rounded-2xl p-6 w-[min(400px,calc(100vw-2rem))] shadow-2xl"
                        onClick={e => e.stopPropagation()}
                    >
                        <h3 id="rename-conv-heading" className="text-base font-semibold text-[#111111] mb-1">Rename conversation</h3>
                        <p className="text-sm text-[#767676] mb-4">Enter a new name for this conversation.</p>
                        <input
                            type="text"
                            value={renamingConvTitle}
                            onChange={e => setRenamingConvTitle(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') confirmRenameConv(renamingConvId);
                                if (e.key === 'Escape') setRenamingConvId(null);
                            }}
                            className="w-full px-3 py-2 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] focus:border-transparent text-[#111111]"
                            autoFocus
                            onFocus={e => e.target.select()}
                        />
                        <div className="flex gap-2 mt-4 justify-end">
                            <button
                                onClick={() => setRenamingConvId(null)}
                                className="px-4 py-2 text-sm font-medium text-[#111111] hover:bg-[#F5F5F5] rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => confirmRenameConv(renamingConvId)}
                                className="px-4 py-2 text-sm font-medium text-white bg-[#0058A3] hover:bg-[#004F93] rounded-lg transition-colors"
                            >
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Rename Document Modal ── */}
            {renamingDoc && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setRenamingDoc(null)}>
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="rename-doc-heading"
                        className="bg-white rounded-lg p-6 w-96 shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 id="rename-doc-heading" className="text-lg font-semibold mb-4">Rename Document</h3>
                        <input
                            type="text"
                            value={newDocName}
                            onChange={(e) => setNewDocName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') confirmRename();
                                if (e.key === 'Escape') setRenamingDoc(null);
                            }}
                            className="w-full px-3 py-2 border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3]"
                            placeholder="Enter new name"
                            autoFocus
                        />
                        <div className="flex gap-2 mt-4 justify-end">
                            <button onClick={() => setRenamingDoc(null)} className="px-4 py-2 text-sm font-medium text-[#111111] hover:bg-[#F5F5F5] rounded-lg transition-colors">Cancel</button>
                            <button onClick={confirmRename} className="px-4 py-2 text-sm font-medium text-white bg-[#0058A3] hover:bg-[#004F93] rounded-lg transition-colors">Confirm</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Conversation Context Menu ── */}
            {openMenuConvId && (() => {
                const menuConv = conversations.find(c => c.id === openMenuConvId);
                if (!menuConv) return null;
                return (
                    <>
                        <div className="fixed inset-0 z-40" onClick={() => setOpenMenuConvId(null)} />
                        <div
                            style={{ top: menuPosition.top, left: Math.max(8, menuPosition.left) }}
                            className="fixed z-50 bg-white border border-[#DFDFDF] rounded-lg shadow-xl py-1.5 w-44"
                        >
                            <button
                                onClick={(e) => { startRenameConv(e, menuConv.id, menuConv.title); setOpenMenuConvId(null); }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[#111111] hover:bg-[#F5F5F5] transition-colors"
                            >
                                <Edit2 className="w-3.5 h-3.5 text-[#767676]" />
                                Rename
                            </button>
                            <button
                                onClick={(e) => { pinConversation(e, menuConv.id); setOpenMenuConvId(null); }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[#111111] hover:bg-[#F5F5F5] transition-colors"
                            >
                                <Pin className={`w-3.5 h-3.5 ${menuConv.pinned ? 'text-[#0058A3]' : 'text-[#767676]'}`} />
                                {menuConv.pinned ? 'Unpin' : 'Pin to top'}
                            </button>
                            <div className="border-t border-[#DFDFDF] my-1" />
                            <button
                                onClick={(e) => { deleteConversation(e, menuConv.id); setOpenMenuConvId(null); }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete
                            </button>
                        </div>
                    </>
                );
            })()}

            {/* ── API Keys Modal ── */}
            {showApiKeyModal && (
                <div
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
                    onClick={() => { setShowApiKeyModal(false); setApiKeyVisible(false); setGroqApiKeyVisible(false); }}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="api-keys-heading"
                        className="bg-white rounded-2xl shadow-2xl w-full max-w-md"
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => {
                            if (e.key === 'Escape') { setShowApiKeyModal(false); setApiKeyVisible(false); setGroqApiKeyVisible(false); }
                        }}
                    >
                        <div className="p-6">
                            <div className="flex items-center gap-3 mb-1">
                                <div className="w-10 h-10 bg-[#F5F5F5] rounded-full flex items-center justify-center flex-shrink-0">
                                    <KeyRound className="w-5 h-5 text-[#0058A3]" aria-hidden="true" />
                                </div>
                                <div>
                                    <h2 id="api-keys-heading" className="text-lg font-semibold text-[#111111]">API Keys</h2>
                                    <p className="text-xs text-[#767676]">Stored locally in your browser</p>
                                </div>
                            </div>

                            {/* Gemini */}
                            <div className="mt-5">
                                <label className="text-xs font-semibold text-[#767676] uppercase tracking-wide">Gemini API Key</label>
                                <p className="text-xs text-[#767676] mt-1 mb-2">Enables AI chat responses.</p>
                                <div className="relative">
                                    <input
                                        type={apiKeyVisible ? 'text' : 'password'}
                                        value={apiKeyInput}
                                        onChange={e => setApiKeyInput(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') commitApiKeys();
                                            if (e.key === 'Escape') { setShowApiKeyModal(false); setApiKeyVisible(false); setGroqApiKeyVisible(false); }
                                        }}
                                        placeholder="Enter your API Key"
                                        className="w-full px-3 py-2.5 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] focus:border-transparent font-mono pr-20 text-[#111111]"
                                        autoFocus
                                    />
                                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                                        <button
                                            type="button"
                                            onClick={() => setApiKeyVisible(v => !v)}
                                            className="p-1 hover:bg-[#F5F5F5] rounded text-[#767676]"
                                            title={apiKeyVisible ? 'Hide key' : 'Show key'}
                                        >
                                            {apiKeyVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                        {apiKeyInput && (
                                            <button
                                                type="button"
                                                onClick={() => setApiKeyInput('')}
                                                className="p-1 hover:bg-[#F5F5F5] rounded text-[#767676]"
                                                title="Clear"
                                            >
                                                <X className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                {geminiApiKey && (
                                    <div className="flex items-center justify-between mt-2">
                                        <p className="text-xs text-[#0058A3] flex items-center gap-1">
                                            <Check className="w-3 h-3" />
                                            API key is configured
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                localStorage.removeItem(GEMINI_KEY_STORAGE);
                                                setGeminiApiKey('');
                                                setApiKeyInput('');
                                            }}
                                            className="text-xs font-medium text-red-500 hover:text-red-600 transition-colors"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                )}
                            </div>

                            <div className="my-5 border-t border-[#DFDFDF]" />

                            {/* Groq */}
                            <div>
                                <label className="text-xs font-semibold text-[#767676] uppercase tracking-wide">Groq API Key</label>
                                <p className="text-xs text-[#767676] mt-1 mb-2">Transcribes meeting recordings. Sent per-request — the backend never stores it.</p>
                                <div className="relative">
                                    <input
                                        type={groqApiKeyVisible ? 'text' : 'password'}
                                        value={groqApiKeyInput}
                                        onChange={e => setGroqApiKeyInput(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') commitApiKeys();
                                            if (e.key === 'Escape') { setShowApiKeyModal(false); setApiKeyVisible(false); setGroqApiKeyVisible(false); }
                                        }}
                                        placeholder="gsk_..."
                                        className="w-full px-3 py-2.5 text-sm border border-[#DFDFDF] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3] focus:border-transparent font-mono pr-20 text-[#111111]"
                                    />
                                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                                        <button
                                            type="button"
                                            onClick={() => setGroqApiKeyVisible(v => !v)}
                                            className="p-1 hover:bg-[#F5F5F5] rounded text-[#767676]"
                                            title={groqApiKeyVisible ? 'Hide key' : 'Show key'}
                                        >
                                            {groqApiKeyVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                        {groqApiKeyInput && (
                                            <button
                                                type="button"
                                                onClick={() => setGroqApiKeyInput('')}
                                                className="p-1 hover:bg-[#F5F5F5] rounded text-[#767676]"
                                                title="Clear"
                                            >
                                                <X className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                {groqApiKey && (
                                    <div className="flex items-center justify-between mt-2">
                                        <p className="text-xs text-orange-500 flex items-center gap-1">
                                            <Check className="w-3 h-3" />
                                            API key is configured
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                localStorage.removeItem(GROQ_KEY_STORAGE);
                                                setGroqApiKey('');
                                                setGroqApiKeyInput('');
                                            }}
                                            className="text-xs font-medium text-red-500 hover:text-red-600 transition-colors"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="px-6 pb-6 flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => { setShowApiKeyModal(false); setApiKeyVisible(false); setGroqApiKeyVisible(false); }}
                                className="px-4 py-2 text-sm font-medium text-[#111111] hover:bg-[#F5F5F5] rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={commitApiKeys}
                                className="px-4 py-2 text-sm font-medium text-white bg-[#0058A3] hover:bg-[#004F93] rounded-lg transition-colors"
                            >
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Avatar Picker ── */}
            {showAvatarPicker && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowAvatarPicker(false)} />
                    <div
                        className="fixed bg-white rounded-lg p-4 sm:p-6 w-[min(320px,calc(100vw-1.5rem))] shadow-2xl border border-[#DFDFDF] z-50"
                        style={{ top: avatarPanelPosition.top, left: avatarPanelPosition.left }}
                    >
                        <h3 className="text-lg font-semibold mb-4">Choose your avatar</h3>
                        <div className="grid grid-cols-3 gap-4">
                            {AVATARS.map((avatar) => (
                                <button
                                    key={avatar.id}
                                    onClick={() => { setUserAvatar(avatar.src); setShowAvatarPicker(false); }}
                                    className={`relative p-2 rounded-lg border-2 transition-all hover:shadow-lg ${userAvatar === avatar.src ? 'border-[#0058A3] bg-[#F5F5F5]' : 'border-[#DFDFDF] hover:border-[#CCCCCC]'}`}
                                >
                                    <img src={avatar.src} alt={avatar.name} className="w-full h-auto rounded" />
                                    {userAvatar === avatar.src && (
                                        <div className="absolute top-1 right-1 bg-[#0058A3] rounded-full p-1">
                                            <Check className="w-3 h-3 text-white" />
                                        </div>
                                    )}
                                    <p className="text-xs text-center mt-2 font-medium">{avatar.name}</p>
                                </button>
                            ))}
                        </div>
                    </div>
                </>
            )}

        </div>
    );
}

export default App;
