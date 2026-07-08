export function parseSseEvent(rawEvent) {
    const lines = rawEvent.split(/\r?\n/);
    let event = 'message';
    const dataLines = [];

    lines.forEach((line) => {
        if (line.startsWith('event:')) {
            event = line.slice(6).trim() || 'message';
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
        }
    });

    if (dataLines.length === 0) return null;

    try {
        return {
            event,
            data: JSON.parse(dataLines.join('\n')),
        };
    } catch {
        return {
            event,
            data: dataLines.join('\n'),
        };
    }
}

export async function readSseStream(response, onEvent) {
    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('Streaming response is not readable.');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');

        while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const parsed = parseSseEvent(rawEvent);
            if (parsed) onEvent(parsed.event, parsed.data);
            boundary = buffer.indexOf('\n\n');
        }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
        const parsed = parseSseEvent(buffer.trim());
        if (parsed) onEvent(parsed.event, parsed.data);
    }
}
