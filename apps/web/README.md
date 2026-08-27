# Happy Tasks web

Next.js App Router frontend for the collaborative task workspace. The initial UI runs against a realistic in-memory adapter with 10,000 tasks, while every feature consumes the replaceable `WorkspaceApi` interface.

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. The root route redirects to the deterministic demo project.

## Data source

Mock mode is the default:

```dotenv
NEXT_PUBLIC_DATA_SOURCE=mock
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
```

To connect the Go API, set `NEXT_PUBLIC_DATA_SOURCE=api`. The HTTP adapter maps UI-friendly lowercase status and priority values to the uppercase OpenAPI enums, sends the demo actor, idempotency, request ID, and version headers, and normalizes responses back into frontend domain models. Assignment search uses the paginated active-membership directory; task details show only current assignees and expose explicit remove controls, while Activity reads append-only assignment history.

The backend should allow `http://localhost:3000` through CORS. Project events stream from `/v1/projects/{projectId}/events?after={cursor}` and reconcile compact task/comment payloads into the TanStack Query cache.

## Quality checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Feature code lives under `features/`; product patterns under `components/patterns/`; reusable primitives under `components/ui/`; and all transport knowledge stays under `lib/api/` and `lib/realtime/`.
