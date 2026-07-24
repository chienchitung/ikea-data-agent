import { describe, it, expect } from 'vitest';
import { normalizeInlineDisplayMath } from './mathText';

describe('normalizeInlineDisplayMath', () => {
    it('turns a standalone $$formula$$ line into a valid 3-line block-math fence', () => {
        const input = [
            '結案完成率的計算方式如下：',
            '',
            '$$x = \\frac{a}{b} \\times 100\\%$$',
            '',
            '- next line',
        ].join('\n');

        const result = normalizeInlineDisplayMath(input);

        // remark-math only recognizes $$ as block math when the opening
        // fence, content, and closing fence are on separate lines — see the
        // comment above normalizeInlineDisplayMath in mathText.js.
        expect(result).toContain('$$\nx = \\frac{a}{b} \\times 100\\%\n$$');
    });

    it('turns a $$formula$$ used inline in a list item into single-dollar inline math', () => {
        const input = '- 計算結果：$$\\frac{62}{73} \\approx 84.9\\%$$';
        const result = normalizeInlineDisplayMath(input);

        expect(result).toBe('- 計算結果：$\\frac{62}{73} \\approx 84.9\\%$');
        // Must not still contain a double-dollar fence.
        expect(result).not.toMatch(/\$\$/);
    });

    it('turns a $$formula$$ used mid-sentence into inline math', () => {
        const input = 'The answer is $$\\frac{62}{73} \\approx 84.9\\%$$ done.';
        const result = normalizeInlineDisplayMath(input);
        expect(result).toBe('The answer is $\\frac{62}{73} \\approx 84.9\\%$ done.');
    });

    it('handles multiple formulas in the same message independently', () => {
        const input = [
            '$$a = b$$',
            '',
            '- inline one: $$c = d$$',
            '- inline two: $$e = f$$',
        ].join('\n');

        const result = normalizeInlineDisplayMath(input);
        expect(result).toContain('$$\na = b\n$$');
        expect(result).toContain('- inline one: $c = d$');
        expect(result).toContain('- inline two: $e = f$');
    });

    it('leaves content with no $$ untouched', () => {
        const input = 'Just plain text with **bold** and no formulas.';
        expect(normalizeInlineDisplayMath(input)).toBe(input);
    });

    it('drops an empty $$$$ pair rather than emitting an empty fence', () => {
        const input = 'Weird empty formula: $$$$ here.';
        const result = normalizeInlineDisplayMath(input);
        expect(result).toBe(input);
    });

    it('trims whitespace inside the formula before re-wrapping it', () => {
        const input = '- result: $$  \\frac{1}{2}  $$';
        const result = normalizeInlineDisplayMath(input);
        expect(result).toBe('- result: $\\frac{1}{2}$');
    });
});
