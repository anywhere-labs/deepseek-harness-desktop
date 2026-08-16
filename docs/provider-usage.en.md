# Provider Health and Model Usage

[中文](provider-usage.md)

DSH Desktop composes a pinned revision of [`dsh-llm-guardian`](https://github.com/ice-kele/dsh-llm-guardian) to add Provider health checks, API account usage, local per-model statistics, and quota enforcement under **Settings → Models**. The plugin is an ordinary DSH Host/Web Client composition and does not use private Electron APIs.

## Provider cards

Each Provider card shows connectivity, locally accumulated tokens, an account balance or plan allowance when supported, and the last refresh time. The heartbeat action tests the endpoint immediately, while the statistics action opens the current Provider's detail view. Existing edit and delete actions remain unchanged.

![Provider-card health and usage actions](images/provider-card-overview.png)

## Per-model statistics

The detail view's **Statistics** tab selects a model under the current Provider and aggregates tokens, sessions, model messages, active days, and the daily trend from local DSH session logs. API account usage and local session statistics are independent, so local statistics remain available when a Provider has no balance endpoint.

![Per-model usage for the current Provider](images/provider-model-usage.png)

## Usage and quota settings

The **Settings** tab independently controls API usage queries, the Provider-card summary, request timeout, automatic refresh interval, and local quota enforcement. An automatic refresh value of `0` disables the timer; an empty quota remains unlimited. Users can reset the local counter, and the guard rejects new requests with an explicit reason when the quota is exceeded or the Provider is unavailable.

![API usage query and local quota settings](images/provider-usage-settings.png)

## Data and network boundaries

- API keys continue to resolve through DSH credentials and are not written to plugin settings or statistics views.
- Connectivity and account queries only access the current Provider endpoint. Custom queries require same-origin HTTPS, with loopback HTTP allowed for local Providers.
- Tokens, sessions, messages, and trends are computed only from local session logs; session content and aggregate results are not uploaded.
- Success, failure, missing configuration, and timeout states include explicit feedback and refresh timestamps.

The plugin is pinned to the validated commit `32db0da4d418a469f625b84582bcf9d93f64fd4f` for reproducible packaging and dependency review.
