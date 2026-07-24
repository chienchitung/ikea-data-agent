import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ChatMessage } from './ChatMessage';

function renderMessage(content, role = 'assistant') {
    return render(
        <ChatMessage
            message={{ role, content }}
            userAvatar="/avatar.png"
            onCopy={() => {}}
            onUpdate={() => {}}
        />
    );
}

describe('ChatMessage rendering', () => {
    it('renders plain markdown (bold, inline code) without loading the math bundle', async () => {
        renderMessage('This has **bold text** and `inline code`.');

        expect(await screen.findByText('bold text')).toBeInTheDocument();
        expect(screen.getByText('inline code')).toBeInTheDocument();
        // No $ in the content — the KaTeX plugin bundle must never load.
        expect(document.querySelector('.katex')).toBeNull();
    });

    it('renders a standalone $$formula$$ as KaTeX once the math bundle loads', async () => {
        renderMessage('$$x = \\frac{a}{b}$$');

        // The math plugin loads asynchronously (dynamic import) — the
        // formula starts as raw text and becomes a .katex node once it
        // resolves. This is the same "flash then upgrade" tradeoff
        // CodeHighlighter already accepts elsewhere in this file.
        await waitFor(() => {
            expect(document.querySelector('.katex')).not.toBeNull();
        });
        expect(document.querySelector('.katex-display')).not.toBeNull();
    });

    it('renders a $$formula$$ used inline in a list item as inline KaTeX', async () => {
        renderMessage('- 計算結果：$$\\frac{62}{73} \\approx 84.9\\%$$');

        await waitFor(() => {
            expect(document.querySelector('.katex')).not.toBeNull();
        });
        // Inline usage should NOT get the block/display treatment.
        expect(document.querySelector('.katex-display')).toBeNull();
    });
});
