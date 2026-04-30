import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { ChatMessage } from './components/ChatMessage';
import { ArrowUp, Loader2, Sparkles, FileText, ChevronDown, ChevronLeft, ChevronRight, Plus, Check, Edit2, Trash2, User, MessageSquare, PenSquare, Search } from 'lucide-react';
import bearAvatar from './assets/img/ikea-bear.png';
import dogAvatar from './assets/img/ikea-dog.png';
import monkeyAvatar from './assets/img/ikea-monkey.png';
import sharkAvatar from './assets/img/ikea-shark.png';
import teddyAvatar from './assets/img/ikea-teddy.png';

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const STORAGE_KEY = 'ikea_agent_conversations';
const CURRENT_ID_KEY = 'ikea_agent_current_id';

const AVATARS = [
    { id: 'bear', name: 'Bear', src: bearAvatar },
    { id: 'dog', name: 'Dog', src: dogAvatar },
    { id: 'monkey', name: 'Monkey', src: monkeyAvatar },
    { id: 'shark', name: 'Shark', src: sharkAvatar },
    { id: 'teddy', name: 'Teddy', src: teddyAvatar },
];

// ── 工具函式 ────────────────────────────────────────────
function generateId() {
    return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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
// ────────────────────────────────────────────────────────

function App() {
    const [input, setInput] = useState("");
    const [messages, setMessages] = useState([]);
    const [currentConvId, setCurrentConvId] = useState(null);
    const [conversations, setConversations] = useState([]);
    const [documents, setDocuments] = useState([]);
    const [selectedDocuments, setSelectedDocuments] = useState(new Set());
    const [isLoading, setIsLoading] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadStage, setUploadStage] = useState("");
    const [isSourcesExpanded, setIsSourcesExpanded] = useState(true);
    const [isConvsExpanded, setIsConvsExpanded] = useState(true);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
        () => typeof window !== 'undefined' && window.innerWidth < 768
    );
    const [renamingDoc, setRenamingDoc] = useState(null);
    const [newDocName, setNewDocName] = useState("");
    const [userAvatar, setUserAvatar] = useState(bearAvatar);
    const [showAvatarPicker, setShowAvatarPicker] = useState(false);
    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);

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

    // ── messages 變動時自動存檔 ───────────────────────────
    useEffect(() => {
        if (messages.length === 0) return;

        setConversations(prev => {
            let updated;
            const exists = prev.find(c => c.id === currentConvId);
            if (exists) {
                updated = prev.map(c =>
                    c.id === currentConvId
                        ? { ...c, messages, title: makeTitle(messages), updatedAt: Date.now() }
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
    }, [messages]);

    // currentConvId 變動時同步到 localStorage
    useEffect(() => {
        if (currentConvId) localStorage.setItem(CURRENT_ID_KEY, currentConvId);
    }, [currentConvId]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    const fetchDocuments = async () => {
        try {
            const response = await axios.get(`${API_URL}/documents`);
            setDocuments(response.data.documents || []);
        } catch (error) {
            console.error("Failed to fetch documents:", error);
        }
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isLoading]);

    useEffect(() => {
        fetchDocuments();
    }, []);

    // ── 對話管理 ─────────────────────────────────────────
    const startNewConversation = () => {
        const newId = generateId();
        setCurrentConvId(newId);
        setMessages([]);
    };

    const switchConversation = (conv) => {
        setCurrentConvId(conv.id);
        setMessages(conv.messages);
    };

    const deleteConversation = (e, convId) => {
        e.stopPropagation();
        const updated = conversations.filter(c => c.id !== convId);
        saveConversations(updated);
        setConversations(updated);

        if (convId === currentConvId) {
            if (updated.length > 0) {
                setCurrentConvId(updated[0].id);
                setMessages(updated[0].messages);
            } else {
                startNewConversation();
            }
        }
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

    const deleteSelectedDocuments = async () => {
        if (selectedDocuments.size === 0) return;
        if (!confirm(`Are you sure you want to delete ${selectedDocuments.size} file(s)?`)) return;

        const toDelete = [...selectedDocuments];
        const failed = [];

        // Optimistic update: immediately remove from UI
        setDocuments(prev => prev.filter(doc => !toDelete.includes(doc)));
        setSelectedDocuments(new Set());

        for (const filename of toDelete) {
            try {
                await axios.delete(`${API_URL}/documents/${filename}`);
            } catch {
                failed.push(filename);
            }
        }

        // Confirm final state from server
        await fetchDocuments();

        if (failed.length === 0) {
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `✅ Deleted ${toDelete.length} file(s) successfully.`
            }]);
        } else {
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `⚠️ Deleted ${toDelete.length - failed.length} file(s). Failed: ${failed.join(', ')}`
            }]);
        }
    };

    const deleteDocument = async (filename) => {
        if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;
        // Optimistic update: immediately remove from UI
        setDocuments(prev => prev.filter(doc => doc !== filename));
        const newSelected = new Set(selectedDocuments);
        newSelected.delete(filename);
        setSelectedDocuments(newSelected);
        try {
            await axios.delete(`${API_URL}/documents/${filename}`);
            await fetchDocuments();
            setMessages(prev => [...prev, { role: 'assistant', content: `✅ File deleted: \`${filename}\`` }]);
        } catch (error) {
            console.error("Delete failed:", error);
            // Rollback: re-fetch to restore accurate state
            await fetchDocuments();
            setMessages(prev => [...prev, { role: 'assistant', content: `❌ Delete failed: ${error.message}` }]);
        }
    };

    const startRename = (doc) => {
        setRenamingDoc(doc);
        setNewDocName(doc.replace('.pdf', ''));
    };

    const confirmRename = async () => {
        if (!newDocName.trim()) return;
        try {
            await axios.put(`${API_URL}/documents/${renamingDoc}`, { new_name: newDocName });
            await fetchDocuments();
            setRenamingDoc(null);
            setNewDocName("");
            setMessages(prev => [...prev, { role: 'assistant', content: `✅ Renamed: \`${renamingDoc}\` → \`${newDocName}.pdf\`` }]);
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
        setUploadStage("上傳檔案中...");
        const formData = new FormData();
        formData.append("file", file);

        try {
            await axios.post(`${API_URL}/upload`, formData, {
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
            setUploadStage("Done!");
            setMessages(prev => [...prev, { role: 'assistant', content: `✅ **PDF Uploaded**: \`${file.name}\` successfully. I can now answer questions about its content.` }]);
        } catch (error) {
            console.error("Upload failed", error);
            const errorMessage = error.response?.data?.message || error.message;
            setMessages(prev => [...prev, { role: 'assistant', content: `❌ **Upload Failed**: ${errorMessage}` }]);
        } finally {
            setTimeout(() => {
                setIsUploading(false);
                setUploadProgress(0);
                setUploadStage("");
                if (fileInputRef.current) fileInputRef.current.value = "";
            }, 800);
        }
    };

    // ── 聊天邏輯 ─────────────────────────────────────────
    const handleSubmit = async (e) => {
        if (e) e.preventDefault();
        if (!input.trim() || isLoading) return;

        const textarea = document.getElementById('chat-input');
        if (textarea) textarea.style.height = 'auto';

        // 若是全新對話（無 ID），建立一個新 ID
        if (!currentConvId) {
            setCurrentConvId(generateId());
        }

        const userMessage = { role: 'user', content: input };
        setMessages(prev => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);

        try {
            const response = await axios.post(`${API_URL}/chat`, {
                message: userMessage.content,
                history: messages
            });
            setMessages(prev => [...prev, { role: 'assistant', content: response.data.response }]);
        } catch (error) {
            console.error("Error:", error);
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: "⚠️ **Error**: Could not connect to the Agent. Please check if the backend is running."
            }]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleMessageUpdate = async (index, newContent) => {
        if (isLoading) return;
        const historyContext = messages.slice(0, index);
        const updatedUserMessage = { ...messages[index], content: newContent };
        setMessages([...historyContext, updatedUserMessage]);
        setIsLoading(true);
        try {
            const response = await axios.post(`${API_URL}/chat`, {
                message: newContent,
                history: historyContext
            });
            setMessages(prev => [...prev, { role: 'assistant', content: response.data.response }]);
        } catch (error) {
            console.error("Error regenerating response:", error);
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: "⚠️ **Error**: Could not regenerate response."
            }]);
        } finally {
            setIsLoading(false);
        }
    };

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
                            <button
                                onClick={() => setIsConvsExpanded(!isConvsExpanded)}
                                className="p-1 hover:bg-[#DFDFDF] rounded transition-colors"
                            >
                                <ChevronDown className={`w-3.5 h-3.5 text-[#767676] transition-transform ${isConvsExpanded ? '' : '-rotate-90'}`} />
                            </button>
                        </div>

                        {isConvsExpanded && (
                            <div className="space-y-0.5">
                                {conversations.length === 0 ? (
                                    <p className="text-sm text-[#767676] text-center py-4">No conversations yet</p>
                                ) : (
                                    conversations
                                        .slice()
                                        .sort((a, b) => b.updatedAt - a.updatedAt)
                                        .map(conv => (
                                            <div
                                                key={conv.id}
                                                onClick={() => switchConversation(conv)}
                                                className={`group flex items-start gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors ${conv.id === currentConvId ? 'bg-white' : 'hover:bg-white'}`}
                                            >
                                                <MessageSquare className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${conv.id === currentConvId ? 'text-[#484848]' : 'text-[#767676]'}`} />
                                                <div className="flex-1 min-w-0">
                                                    <p className={`text-sm font-medium truncate ${conv.id === currentConvId ? 'text-[#484848]' : 'text-[#111111]'}`}>
                                                        {conv.title}
                                                    </p>
                                                    <p className="text-xs text-[#767676] mt-0.5">
                                                        {formatRelativeTime(conv.updatedAt)}
                                                    </p>
                                                </div>
                                                <button
                                                    onClick={(e) => deleteConversation(e, conv.id)}
                                                    className="flex-shrink-0 p-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-red-100 rounded transition-all"
                                                    title="Delete conversation"
                                                >
                                                    <Trash2 className="w-3 h-3 text-red-500" />
                                                </button>
                                            </div>
                                        ))
                                )}
                            </div>
                        )}
                    </div>

                    {/* Divider */}
                    <div className="mx-4 border-t border-[#DFDFDF] my-2" />

                    {/* ── Sources Section ── */}
                    <div className="px-4">
                        <div className="flex items-center justify-between py-2">
                            <span className="text-xs font-semibold text-[#767676] tracking-widest uppercase">Sources</span>
                            <button
                                onClick={() => setIsSourcesExpanded(!isSourcesExpanded)}
                                className="p-1 hover:bg-[#DFDFDF] rounded transition-colors"
                            >
                                <ChevronDown className={`w-3.5 h-3.5 text-[#767676] transition-transform ${isSourcesExpanded ? '' : '-rotate-90'}`} />
                            </button>
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
                                        <div className="flex items-center justify-between mb-1">
                                            <button
                                                onClick={toggleSelectAll}
                                                className="flex items-center gap-2 hover:bg-white rounded px-2 py-1 transition-colors"
                                            >
                                                <div className={`w-3.5 h-3.5 rounded border-2 flex-shrink-0 ${selectedDocuments.size === documents.length && documents.length > 0 ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center`}>
                                                    {selectedDocuments.size === documents.length && documents.length > 0 && <Check className="w-2.5 h-2.5 text-white" />}
                                                </div>
                                                <span className="text-sm text-[#484848]">Select all</span>
                                            </button>
                                            {selectedDocuments.size > 0 && (
                                                <button
                                                    onClick={deleteSelectedDocuments}
                                                    className="flex items-center gap-1 px-2 py-1 text-sm text-red-600 hover:bg-red-50 rounded transition-colors"
                                                    title={`Delete ${selectedDocuments.size} selected`}
                                                >
                                                    <Trash2 className="w-3 h-3" />
                                                    Delete ({selectedDocuments.size})
                                                </button>
                                            )}
                                        </div>
                                        {documents.map((doc, idx) => (
                                            <div key={idx} className="flex items-center gap-2 p-2 rounded-lg hover:bg-white transition-colors group">
                                                <button onClick={() => toggleDocumentSelection(doc)} className="flex-shrink-0">
                                                    <div className={`w-4 h-4 rounded border-2 ${selectedDocuments.has(doc) ? 'border-[#0058A3] bg-[#0058A3]' : 'border-[#CCCCCC]'} flex items-center justify-center transition-colors`}>
                                                        {selectedDocuments.has(doc) && <Check className="w-2.5 h-2.5 text-white" />}
                                                    </div>
                                                </button>
                                                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                                                    <FileText className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                                                    <span className="text-sm text-[#111111] truncate" title={doc}>{doc}</span>
                                                </div>
                                                <div className="flex-shrink-0 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                                    <button onClick={() => startRename(doc)} className="p-1 hover:bg-[#DFDFDF] rounded" title="Rename">
                                                        <Edit2 className="w-3 h-3 text-[#484848]" />
                                                    </button>
                                                    <button onClick={() => deleteDocument(doc)} className="p-1 hover:bg-red-100 rounded" title="Delete">
                                                        <Trash2 className="w-3 h-3 text-red-500" />
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                <div className="p-3 border-t border-[#DFDFDF] flex-shrink-0">
                    <div className="text-xs text-[#767676] text-center">Developed by IKEA Data Team</div>
                </div>
            </aside>

            {/* Sidebar collapsed toggle — shown when sidebar is closed */}
            {isSidebarCollapsed && (
                <button
                    onClick={() => setIsSidebarCollapsed(false)}
                    className="fixed left-3 top-24 z-20 bg-white border border-[#DFDFDF] rounded-full p-2 shadow-lg hover:bg-[#F5F5F5] transition-colors"
                    aria-label="Expand sidebar"
                    title="Expand sidebar"
                >
                    <ChevronRight className="w-5 h-5 text-[#111111]" />
                </button>
            )}

            {/* ── Main Content ── */}
            <div className="flex-1 flex flex-col min-w-0 bg-white">

                {/* Header */}
                <header className="bg-white min-h-[84px] flex items-center shadow-sm border-b border-[#DFDFDF] flex-shrink-0">
                    <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-3 flex items-center justify-between">
                        <button
                            type="button"
                            onClick={startNewConversation}
                            className="flex items-center gap-4 min-w-0 text-left"
                            aria-label="Start a new conversation"
                            title="Start a new conversation"
                        >
                            <img
                                src="https://www.inter.ikea.com/-/media/aboutikea/images/brand-default.svg?rev=23ee61ddbb1948f399b47938edeb3c11"
                                alt="IKEA Logo"
                                className="h-[36px] w-auto flex-shrink-0"
                            />
                            <div className="pl-4 border-l border-[#DFDFDF] min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                    <h1 className="text-xl sm:text-2xl font-bold text-[#111111] leading-[1.67] truncate">Data Machi</h1>
                                    <span className="hidden sm:inline-flex rounded-full bg-[#DFDFDF] px-2 py-0.5 text-xs font-bold text-[#111111]">
                                        Beta
                                    </span>
                                </div>
                                <p className="text-xs text-[#767676] font-medium tracking-wide">Ask your data partner</p>
                            </div>
                        </button>
                        <div className="flex items-center gap-1">
                            {/* Clear / New chat button */}
                            {messages.length > 0 && (
                                <button
                                    onClick={startNewConversation}
                                    className="p-2 hover:bg-[#F5F5F5] rounded-full transition-colors"
                                    title="Start new conversation"
                                >
                                    <PenSquare className="w-5 h-5 text-[#111111]" />
                                </button>
                            )}
                            <button
                                onClick={() => setShowAvatarPicker(!showAvatarPicker)}
                                className="p-2 hover:bg-[#F5F5F5] rounded-full transition-colors"
                                title="Change avatar"
                            >
                                <User className="w-5 h-5 text-[#111111]" />
                            </button>
                        </div>
                    </div>
                </header>

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
                                    onUpdate={(newContent) => handleMessageUpdate(idx, newContent)}
                                    onCopy={(content) => navigator.clipboard.writeText(content)}
                                />
                            ))}
                            {isLoading && (
                                <div className="flex justify-start">
                                    <div className="typing-indicator">
                                        <div className="typing-dot"></div>
                                        <div className="typing-dot"></div>
                                        <div className="typing-dot"></div>
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </div>
                    )}
                </main>

                {/* Input */}
                <footer className="w-full max-w-4xl mx-auto px-2 sm:px-4 py-3 bg-white">
                    <form onSubmit={handleSubmit} className="chatbot-input-container">
                        {!input.trim() && <Search className="input-leading-icon" aria-hidden="true" />}
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
                            placeholder="Type your question here"
                            disabled={isLoading}
                            className="chatbot-input"
                            rows={1}
                        />
                        {input.trim() && (
                            <button type="submit" disabled={isLoading} className="send-button" aria-label="Send message">
                                <ArrowUp />
                            </button>
                        )}
                    </form>
                    <div className="text-center mt-2 pb-2">
                        <p className="text-[10px] text-[#767676] font-medium">AI can make mistakes. Please verify important information.</p>
                    </div>
                </footer>
            </div>

            {/* ── Rename Modal ── */}
            {renamingDoc && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setRenamingDoc(null)}>
                    <div className="bg-white rounded-lg p-6 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
                        <h3 className="text-lg font-semibold mb-4">Rename Document</h3>
                        <input
                            type="text"
                            value={newDocName}
                            onChange={(e) => setNewDocName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && confirmRename()}
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

            {/* ── Avatar Picker ── */}
            {showAvatarPicker && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowAvatarPicker(false)} />
                    <div className="fixed top-20 right-3 sm:right-6 bg-white rounded-lg p-4 sm:p-6 w-[min(320px,calc(100vw-1.5rem))] shadow-2xl border border-[#DFDFDF] z-50">
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
