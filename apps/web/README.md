# Happy Tasks web

Next.js App Router frontend for the collaborative task workspace. API mode is the default; every feature consumes the replaceable `WorkspaceApi` interface and mock mode remains available for deterministic UI demos.

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. The root route redirects to the first authenticated project in API mode.

## Data source

Mock mode is opt-in:

```dotenv
NEXT_PUBLIC_DATA_SOURCE=mock
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
# Optional: show the MOCK API/GO API transport badge in the header.
NEXT_PUBLIC_DEBUG_UI=false
```

To connect the Go API, set `NEXT_PUBLIC_DATA_SOURCE=api`. The HTTP adapter maps UI-friendly lowercase status and priority values to the uppercase OpenAPI enums, sends browser credentials plus idempotency, request ID, and version headers, and normalizes responses back into frontend domain models. Assignment search uses the paginated active-membership directory; task details show only current assignees and expose explicit remove controls, while Activity reads append-only assignment history.

The backend should allow `http://localhost:3000` through CORS. Project events stream from `/v1/projects/{projectId}/events?after={cursor}` and reconcile compact task/comment/reaction/notification payloads into the TanStack Query cache. Ephemeral presence and description selection use `/v1/projects/{projectId}/collaboration/live`; the activity route reads the same durable event window through `/v1/projects/{projectId}/activity`.

API mode includes `/login` for email/password sessions. Requests and project SSE replay send browser credentials; private task files are uploaded as multipart data and downloaded through the authenticated attachment route. The service worker caches only the app shell and offline fallback, never private API responses.

## Quality checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Feature code lives under `features/`; product patterns under `components/patterns/`; reusable primitives under `components/ui/`; and all transport knowledge stays under `lib/api/` and `lib/realtime/`.
