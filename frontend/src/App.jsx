import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { ChatMessage } from './components/ChatMessage';
import { Send, Loader2, Sparkles, FileText, ChevronDown, Plus, Check, Edit2, Trash2, Menu, User } from 'lucide-react';
import bearAvatar from './assets/img/ikea-bear.png';
import dogAvatar from './assets/img/ikea-dog.png';
import monkeyAvatar from './assets/img/ikea-monkey.png';
import sharkAvatar from './assets/img/ikea-shark.png';
import teddyAvatar from './assets/img/ikea-teddy.png';

const API_URL = "http://localhost:8000";

const AVATARS = [
    { id: 'bear', name: 'Bear', src: bearAvatar },
    { id: 'dog', name: 'Dog', src: dogAvatar },
    { id: 'monkey', name: 'Monkey', src: monkeyAvatar },
    { id: 'shark', name: 'Shark', src: sharkAvatar },
    { id: 'teddy', name: 'Teddy', src: teddyAvatar },
];

function App() {
    const [input, setInput] = useState("");
    const [messages, setMessages] = useState([]);
    const [documents, setDocuments] = useState([]);
    const [selectedDocuments, setSelectedDocuments] = useState(new Set());
    const [isLoading, setIsLoading] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [isSourcesExpanded, setIsSourcesExpanded] = useState(true);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
    const [renamingDoc, setRenamingDoc] = useState(null);
    const [newDocName, setNewDocName] = useState("");
    const [userAvatar, setUserAvatar] = useState(bearAvatar);
    const [showAvatarPicker, setShowAvatarPicker] = useState(false);
    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);

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

    const deleteDocument = async (filename) => {
        if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;

        try {
            await axios.delete(`${API_URL}/documents/${filename}`);
            await fetchDocuments();

            const newSelected = new Set(selectedDocuments);
            newSelected.delete(filename);
            setSelectedDocuments(newSelected);

            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `✅ File deleted: \`${filename}\``
            }]);
        } catch (error) {
            console.error("Delete failed:", error);
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `❌ Delete failed: ${error.message}`
            }]);
        }
    };

    const startRename = (doc) => {
        setRenamingDoc(doc);
        setNewDocName(doc.replace('.pdf', ''));
    };

    const confirmRename = async () => {
        if (!newDocName.trim()) return;

        try {
            await axios.put(`${API_URL}/documents/${renamingDoc}`, {
                new_name: newDocName
            });
            await fetchDocuments();
            setRenamingDoc(null);
            setNewDocName("");

            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `✅ Renamed: \`${renamingDoc}\` → \`${newDocName}.pdf\``
            }]);
        } catch (error) {
            console.error("Rename failed:", error);
            alert(`Rename failed: ${error.message}`);
        }
    };

    const handleFileUpload = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        const formData = new FormData();
        formData.append("file", file);

        try {
            await axios.post(`${API_URL}/upload`, formData, {
                headers: {
                    'Content-Type': 'multipart/form-data',
                },
            });

            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `✅ **PDF Uploaded**: \`${file.name}\` successfully. I can now answer questions about its content.`
            }]);

            fetchDocuments();
        } catch (error) {
            console.error("Upload failed", error);
            const errorMessage = error.response?.data?.message || error.message;
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `❌ **Upload Failed**: ${errorMessage}`
            }]);
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMessage = { role: 'user', content: input };
        setMessages(prev => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);

        try {
            const payload = {
                message: userMessage.content,
                history: messages
            };

            const response = await axios.post(`${API_URL}/chat`, payload);

            const agentMessage = { role: 'assistant', content: response.data.response };
            setMessages(prev => [...prev, agentMessage]);
        } catch (error) {
            console.error("Error:", error);
            const errorMessage = {
                role: 'assistant',
                content: "⚠️ **Error**: Could not connect to the Agent. Please check if the backend is running."
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleMessageUpdate = async (index, newContent) => {
        if (isLoading) return;

        // Create new history up to the edited message
        // 1. Get messages up to (but not including) the edited message for context
        const historyContext = messages.slice(0, index);

        // 2. Create the new user message
        const updatedUserMessage = { ...messages[index], content: newContent };

        // 3. Update local state immediately: Keep history + updated message, remove everything after
        setMessages([...historyContext, updatedUserMessage]);
        setIsLoading(true);

        try {
            const payload = {
                message: newContent,
                history: historyContext
            };

            const response = await axios.post(`${API_URL}/chat`, payload);

            const agentMessage = { role: 'assistant', content: response.data.response };
            setMessages(prev => [...prev, agentMessage]);
        } catch (error) {
            console.error("Error regenerating response:", error);
            const errorMessage = {
                role: 'assistant',
                content: "⚠️ **Error**: Could not regenerate response. Please check backend connection."
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex h-screen bg-[#F9F9F9]">
            {/* Sidebar */}
            <aside className={`${isSidebarCollapsed ? 'w-0' : 'w-80'} bg-white border-r border-slate-200 flex flex-col transition-all duration-300 overflow-hidden`}>
                <div className="h-[72px] flex items-center justify-between px-4 border-b border-slate-100 flex-shrink-0">
                    <h2 className="text-sm font-semibold text-[#111111]">Sources</h2>
                    <button
                        onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                        className="p-1.5 hover:bg-slate-100 rounded transition-colors"
                    >
                        <Menu className="w-5 h-5 text-gray-600" />
                    </button>
                </div>

                <div className="p-4 flex-shrink-0">
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors text-sm font-medium text-gray-700 disabled:opacity-50"
                    >
                        {isUploading ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Uploading...
                            </>
                        ) : (
                            <>
                                <Plus className="w-4 h-4" />
                                Add Source
                            </>
                        )}
                    </button>
                    <input
                        type="file"
                        accept=".pdf"
                        onChange={handleFileUpload}
                        style={{ display: 'none' }}
                        ref={fileInputRef}
                    />
                </div>

                <div className="flex-1 overflow-y-auto px-4">
                    <div className="w-full flex items-center justify-between py-2 text-sm font-medium text-gray-700 rounded px-2">
                        <button
                            onClick={toggleSelectAll}
                            className="flex items-center gap-2 hover:bg-slate-50 rounded px-2 py-1 transition-colors"
                        >
                            <div className={`w-4 h-4 rounded border-2 ${selectedDocuments.size === documents.length && documents.length > 0 ? 'border-[#0058A3] bg-[#0058A3]' : 'border-gray-300'} flex items-center justify-center`}>
                                {selectedDocuments.size === documents.length && documents.length > 0 && (
                                    <Check className="w-3 h-3 text-white" />
                                )}
                            </div>
                            <span>Select all</span>
                        </button>
                        <button
                            onClick={() => setIsSourcesExpanded(!isSourcesExpanded)}
                            className="p-1 hover:bg-slate-100 rounded transition-colors"
                        >
                            <ChevronDown className={`w-4 h-4 transition-transform ${isSourcesExpanded ? '' : '-rotate-90'}`} />
                        </button>
                    </div>

                    {isSourcesExpanded && (
                        <div className="mt-2 space-y-1">
                            {documents.length === 0 ? (
                                <div className="text-center py-8 text-gray-400 text-sm">
                                    <p>No documents uploaded</p>
                                    <p className="text-xs mt-1">Click + to add a PDF</p>
                                </div>
                            ) : (
                                documents.map((doc, idx) => (
                                    <div
                                        key={idx}
                                        className="flex items-center gap-2 p-2 rounded-lg hover:bg-slate-50 transition-colors group"
                                    >
                                        <button
                                            onClick={() => toggleDocumentSelection(doc)}
                                            className="flex-shrink-0"
                                        >
                                            <div className={`w-5 h-5 rounded border-2 ${selectedDocuments.has(doc) ? 'border-[#0058A3] bg-[#0058A3]' : 'border-gray-300'} flex items-center justify-center transition-colors`}>
                                                {selectedDocuments.has(doc) && (
                                                    <Check className="w-3.5 h-3.5 text-white" />
                                                )}
                                            </div>
                                        </button>

                                        <div className="flex items-center gap-2 flex-1 min-w-0">
                                            <FileText className="w-4 h-4 text-red-500 flex-shrink-0" />
                                            <span className="text-sm text-gray-700 truncate" title={doc}>
                                                {doc}
                                            </span>
                                        </div>

                                        <div className="flex-shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={() => startRename(doc)}
                                                className="p-1 hover:bg-slate-200 rounded transition-colors"
                                                title="Rename"
                                            >
                                                <Edit2 className="w-3.5 h-3.5 text-gray-600" />
                                            </button>
                                            <button
                                                onClick={() => deleteDocument(doc)}
                                                className="p-1 hover:bg-red-100 rounded transition-colors"
                                                title="Delete"
                                            >
                                                <Trash2 className="w-3.5 h-3.5 text-red-600" />
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </div>

                <div className="p-4 border-t border-slate-100 flex-shrink-0">
                    <div className="text-[10px] text-gray-400 text-center">
                        Document Agent Active
                    </div>
                </div>
            </aside>

            {isSidebarCollapsed && (
                <button
                    onClick={() => setIsSidebarCollapsed(false)}
                    className="fixed left-0 top-20 z-20 bg-white border border-slate-200 rounded-r-lg p-2 shadow-lg hover:bg-slate-50 transition-colors"
                >
                    <Menu className="w-5 h-5 text-gray-600" />
                </button>
            )}

            <div className="flex-1 flex flex-col">
                <header className="bg-white h-[72px] flex items-center shadow-sm border-b border-slate-100">
                    <div className="max-w-4xl mx-auto w-full px-6 flex items-center justify-between">
                        <div className="flex items-center">
                            <img
                                src="https://www.inter.ikea.com/-/media/aboutikea/images/brand-default.svg?rev=23ee61ddbb1948f399b47938edeb3c11"
                                alt="IKEA Logo"
                                className="h-[28px]"
                            />
                            <div className="ml-4 pl-4 border-l border-slate-200">
                                <h1 className="text-sm font-bold text-[#111111] leading-tight">IKEA Data Agent</h1>
                                <p className="text-[10px] text-[#767676] font-medium tracking-wide">ASSISTANT</p>
                            </div>
                        </div>
                        <button
                            onClick={() => setShowAvatarPicker(!showAvatarPicker)}
                            className="p-2 hover:bg-slate-100 rounded-full transition-colors relative"
                            title="Change avatar"
                        >
                            <User className="w-5 h-5 text-gray-600" />
                        </button>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-6">
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
                                    onCopy={(content) => {
                                        navigator.clipboard.writeText(content);
                                    }}
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

                <footer className="w-full max-w-4xl mx-auto p-4 bg-transparent">
                    <form onSubmit={handleSubmit} className="chatbot-input-container !bg-white !shadow-lg">
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Message your agent..."
                            disabled={isLoading}
                            className="chatbot-input"
                        />

                        <button
                            type="submit"
                            disabled={!input.trim() || isLoading}
                            className="send-button"
                        >
                            <Send />
                        </button>
                    </form>
                    <div className="text-center mt-2 pb-2">
                        <p className="text-[10px] text-[#767676] font-medium">AI can make mistakes. Please verify important information.</p>
                    </div>
                </footer>
            </div>

            {renamingDoc && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setRenamingDoc(null)}>
                    <div className="bg-white rounded-lg p-6 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
                        <h3 className="text-lg font-semibold mb-4">Rename Document</h3>
                        <input
                            type="text"
                            value={newDocName}
                            onChange={(e) => setNewDocName(e.target.value)}
                            onKeyPress={(e) => e.key === 'Enter' && confirmRename()}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0058A3]"
                            placeholder="Enter new name"
                            autoFocus
                        />
                        <div className="flex gap-2 mt-4 justify-end">
                            <button
                                onClick={() => setRenamingDoc(null)}
                                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-slate-100 rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmRename}
                                className="px-4 py-2 text-sm font-medium text-white bg-[#0058A3] hover:bg-[#004A8F] rounded-lg transition-colors"
                            >
                                Confirm
                            </button>
                        </div>
                    </div>
                </div>
            )}


            {/* Avatar Picker Popup */}
            {showAvatarPicker && (
                <>
                    {/* Invisible backdrop to close on outside click */}
                    <div
                        className="fixed inset-0 z-40"
                        onClick={() => setShowAvatarPicker(false)}
                    />
                    <div className="fixed top-20 right-6 bg-white rounded-lg p-6 max-w-md w-80 shadow-2xl border border-slate-200 z-50">
                        <h3 className="text-lg font-semibold mb-4">Choose your avatar</h3>
                        <div className="grid grid-cols-3 gap-4">
                            {AVATARS.map((avatar) => (
                                <button
                                    key={avatar.id}
                                    onClick={() => {
                                        setUserAvatar(avatar.src);
                                        setShowAvatarPicker(false);
                                    }}
                                    className={`relative p-2 rounded-lg border-2 transition-all hover:shadow-lg ${userAvatar === avatar.src
                                        ? 'border-[#0058A3] bg-blue-50'
                                        : 'border-slate-200 hover:border-slate-300'
                                        }`}
                                >
                                    <img
                                        src={avatar.src}
                                        alt={avatar.name}
                                        className="w-full h-auto rounded"
                                    />
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
