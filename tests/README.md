# Tests

## Running

```bash
npm test          # single run
npm run test:watch # watch mode
```

## Test files

- `testbed-smoke.test.ts` — smoke test verifying shared memory produces higher peak false-claim endorsement than personal memory. Exercises the full pipeline: config loading, engine execution, metric computation, and summary output.

## What the smoke test validates

1. Both `personal-memory-run.yaml` and `shared-memory-run.yaml` configs load and run without errors
2. Both runs produce valid `RunSummary` objects with all expected fields
3. Shared memory condition has a higher `peakFalseClaimEndorsementRate` than personal memory
4. All metric values are within valid ranges (0-1 for rates, non-negative for steps)
