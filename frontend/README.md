# Data Machi Frontend

React + Vite frontend for the IKEA Data Agent chat UI.

## Local Development

Requirements:

- Node.js `^20.19.0` or `>=22.12.0` because this project uses Vite 7.

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

By default, the frontend calls `http://localhost:8000`.

To point the frontend at another backend:

```bash
VITE_API_URL=http://127.0.0.1:8001 npm run dev
```

You can also create `frontend/.env.local`:

```env
VITE_API_URL=http://127.0.0.1:8000
```

## AI Debug Mode

The AI Debug button is for local development only. It shows metadata such as turn-context routing, tool usage, elapsed time, and token usage when available.

Enable it for one dev session:

```bash
VITE_DEBUG_AI=true npm run dev
```

Enable it together with a custom backend:

```bash
VITE_DEBUG_AI=true VITE_API_URL=http://127.0.0.1:8001 npm run dev
```

Or add this to `frontend/.env.local`:

```env
VITE_DEBUG_AI=true
VITE_API_URL=http://127.0.0.1:8000
```

Production builds never show the Debug button because the UI checks both `import.meta.env.DEV` and `VITE_DEBUG_AI=true`.

## Verification

```bash
npm run lint
npm run build
```
