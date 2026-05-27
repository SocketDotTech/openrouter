# Project Context

For OpenRouter contract work read files which are relevant for the task. general context - `OPENROUTER_CONTEXT.md`
assumptions - `OPENROUTER_ASSUMPTIONS.md` first.

Main ship target is `src/OpenRouter.sol` (contract `OpenRouter`). If its ABI changes, update the backend encoders in `bungee-backend/src/modules/dex/utils.ts` and `bungee-backend/src/modules/router/utils/directQuotesOpenRouter.ts`, and e2e ABI in `scripts/e2e/utils/routerAbi.ts`.
