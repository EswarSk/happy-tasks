# Load-test results

The checked-in scenario at [`scripts/load/tasks.js`](../scripts/load/tasks.js)
measures cursor-backed task-page reads against the seeded 10,000-task project.
Run it with `make load` after starting the Compose stack and loading the scale
seed.

## Baseline

| Date | Machine | Seed | Concurrency | Requests | Errors | Median | p95 | Page body |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-08-28 | Apple Silicon MacBook Pro, macOS Darwin 25.6.0 | 10,000 tasks / 12,000 comments | 20 VUs for 30s | 2,920 | 0.00% | 4.88 ms | 8.61 ms | 59,124 B |

Command used:

```bash
VUS=20 DURATION=30s BASE_URL=http://127.0.0.1:18080 \
  ACTOR_ID=00000000-0000-7000-8000-000000000001 \
  k6 run scripts/load/tasks.js
```

The k6 compact-page check stayed below 256 KiB for every response. The
database plan for the same first page was an index scan using
`tasks_project_updated_idx`.

This is a local baseline, not a universal capacity claim. Re-run it after
changing the schema, query, seed size, or deployment topology.
