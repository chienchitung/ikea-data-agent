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

    it('renders two currency amounts as plain text, not as an accidental math span', async () => {
        renderMessage(
            'Total Sales：4,510,459（Web Sales $2,891,368 / App Sales $1,619,091）'
        );

        // Both full amounts must appear as plain text...
        expect(await screen.findByText(/Web Sales \$2,891,368/)).toBeInTheDocument();
        expect(screen.getByText(/App Sales \$1,619,091/)).toBeInTheDocument();
        // ...and remark-math must never have swallowed the text between the
        // two "$" into a KaTeX span (the reported bug: "2,891,368 / App
        // Sales" rendered in KaTeX's italic math font).
        expect(document.querySelector('.katex')).toBeNull();
    });

    it('still renders genuine $$formula$$ math even in a message that also has plain currency', async () => {
        renderMessage('營收 $1,000 元，公式：$$x = \\frac{a}{b}$$');

        await waitFor(() => {
            expect(document.querySelector('.katex')).not.toBeNull();
        });
        expect(screen.getByText(/\$1,000 元/)).toBeInTheDocument();
    });

    it('renders a literal <br> inside a table cell as an actual line break', async () => {
        renderMessage(
            '| 項目 | 具體行動 |\n' +
            '| --- | --- |\n' +
            '| 1 | 排查購物車 403 錯誤。<br>2. 修復行動支付跳轉 |\n'
        );

        const cell = await screen.findByText(/排查購物車 403 錯誤/);
        // The literal "<br>" text must not survive into the rendered cell —
        // it should have become a real <br> element splitting the content.
        expect(cell.textContent).not.toContain('<br>');
        expect(cell.querySelector('br')).not.toBeNull();
        expect(screen.getByText(/修復行動支付跳轉/)).toBeInTheDocument();
    });
});
