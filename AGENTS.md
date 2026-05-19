# Project Context

For OpenRouter contract work read files which are relevant for the task. general context - `OPENROUTER_CONTEXT.md`
assumptions - `OPENROUTER_ASSUMPTIONS.md` first.

Main ship target is `src/combined/OpenRouterV2Unchecked.sol`. If its ABI changes, update the backend encoders in `bungee-backend/src/modules/dex/utils.ts` and `bungee-backend/src/modules/router/utils/directQuotesOpenRouter.ts`.
