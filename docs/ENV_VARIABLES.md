# Environment Variables

| Variable | Purpose | Format / Source |
|---|---|---|
| `OPENROUTER_API_KEY` | Primary paid LLM gateway provider | OpenRouter API key |
| `ANTHROPIC_API_KEY` | Direct Anthropic fallback | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI chat, vision, and existing extraction | OpenAI API key |
| `GOOGLE_AI_API_KEY` / `GEMINI_API_KEY` | Google AI Studio fallback | Google AI Studio key |
| `GROQ_API_KEY` | Fast inference fallback | Groq Cloud key |
| `CEREBRAS_API_KEY` | Fast inference fallback | Cerebras key |
| `MISTRAL_API_KEY` | Mistral La Plateforme fallback | Mistral key |
| `DEEPSEEK_API_KEY` | DeepSeek direct fallback | DeepSeek key |
| `VOYAGE_API_KEY` | Primary 1024-dim memory embeddings | Voyage AI key |
| `JINA_API_KEY` | Fallback 1024-dim memory embeddings | Jina AI key |
| `SIRAGPT_LLM_GATEWAY_TIMEOUT_MS` | Per-provider circuit-breaker timeout | Milliseconds, default `45000` |
| `SIRAGPT_LLM_GATEWAY_BREAKER_RESET_MS` | Circuit reset window | Milliseconds, default `60000` |
| `SIRAGPT_USER_MEMORY_STORE` | Enables pgvector user memory when set to `pgvector` | Empty or `pgvector` |
| `SIRAGPT_MEMORY_EMBED_PROVIDER` | Memory embedding provider | `voyage` or `jina` |
| `SIRAGPT_MEMORY_EMBED_MODEL` | Memory embedding model | 1024-dimension model id |
| `TAVILY_API_KEY` | Primary fresh web search tool | Tavily key |
| `EXA_API_KEY` | Semantic academic search fallback | Exa key |
| `FIRECRAWL_API_KEY` | Optional deep scraping | Firecrawl key |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key | Langfuse Cloud/self-hosted |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key | Langfuse Cloud/self-hosted |
| `LANGFUSE_HOST` | Langfuse endpoint | URL, default cloud host |
| `LANGFUSE_SAMPLE_RATE` | Trace sampling | `0` to `1` |
| `SENTRY_DSN` | Error capture | Sentry project DSN |
| `SENTRY_TRACES_SAMPLE_RATE` | Sentry performance sampling | `0` to `1` |
| `R2_ACCOUNT_ID` | Cloudflare R2 account | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | R2 S3-compatible access key | Cloudflare R2 key |
| `R2_SECRET_ACCESS_KEY` | R2 S3-compatible secret | Cloudflare R2 secret |
| `R2_BUCKET_NAME` | Artifact bucket | Bucket name |
| `R2_BUCKET` | Backward-compatible artifact bucket alias | Bucket name |
| `R2_ENDPOINT` | Optional custom R2 endpoint | URL |
| `R2_PRESIGNED_URL_TTL_SECONDS` | Short-lived artifact URL TTL | Seconds, default `900` |
| `OPENCLAW_ENABLED` | Enables optional multichannel adapter | Boolean |
| `OPENCLAW_GATEWAY_URL` | OpenClaw gateway URL | URL |
| `OPENCLAW_API_KEY` | Dedicated internal API key | Secret string |
| `OPENCLAW_CHANNELS` | Enabled external channels | Comma-separated channel list |
| `SIRAGPT_INTERNAL_API_URL` | Backend URL used by OpenClaw | URL |
| `SIRAGPT_INTERNAL_API_KEY` | API key for service-to-service calls | Secret string |
| `UPSTASH_REDIS_REST_URL` | Redis REST endpoint for cache/rate-limit options | Upstash URL |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST token | Upstash token |
| `SIRAGPT_CACHE_TTL_DEFAULT_SECONDS` | Default semantic LLM cache TTL | Seconds, default `3600` |
| `SIRAGPT_CACHE_TTL_CODE` / `SIRAGPT_CACHE_TTL_SPEED` | Optional per-task semantic cache TTL overrides | Seconds |
