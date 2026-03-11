# Claude Code Kilo Bridge

Run Claude Code through Kilo Gateway with **free models** like `minimax/minimax-m2.5:free`.

Claude Code Kilo Bridge is a lightweight Node.js proxy that translates Anthropic/Claude Code requests into OpenAI-style requests for Kilo Gateway, then maps the responses back to Anthropic format.

---

## Free models first

Kilo offers **free models**. Set either `DEFAULT_MODEL` or `ANTHROPIC_MODEL` to a free model (for example, `minimax/minimax-m2.5:free`) to get started without paid usage.

---

## Prerequisites

- Node.js 18+
- npm
- Kilo Gateway API key

---

## Installation

1. Clone the repository:

   ```
   git clone git@github.com:manmeet0409/claude-code-kilo-bridge.git
   ```

2. Install dependencies:

   ```
   cd claude-code-kilo-bridge
   npm install
   ```

---

## Environment setup

1. Copy the example file:

   ```
   cp .env.example .env
   ```

2. Fill in values in `.env`:

   ```
   KILO_API_KEY=your_kilo_api_key_here
   INCOMING_API_KEY=your_incoming_proxy_key
   DEFAULT_MODEL=minimax/minimax-m2.5:free
   PORT=3000
   KILO_BASE=https://api.kilo.ai/api/gateway
   ```

### Variables

| Variable           | Required | Purpose |
| ------------------ | -------- | ------- |
| `KILO_API_KEY`     | Yes      | Kilo Gateway API key used for outbound requests. |
| `INCOMING_API_KEY` | No       | If set, clients must send this value as a bearer token or `x-api-key`. |
| `DEFAULT_MODEL`    | Yes      | Model used when a request omits a model (recommended: a **free model**). |
| `PORT`             | Yes      | Local port for the proxy server. |
| `KILO_BASE`        | Yes      | Kilo Gateway base URL. |

---

## Claude Code setup

Set the Claude CLI to use this proxy by defining Anthropic env vars. You can use a `.claude/settings.json` file:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_API_KEY": "your_incoming_proxy_key",
    "ANTHROPIC_MODEL": "minimax/minimax-m2.5:free"
  }
}
```

Notes:

- If `INCOMING_API_KEY` is set, `ANTHROPIC_API_KEY` must match it.
- If `INCOMING_API_KEY` is not set, you can set `ANTHROPIC_API_KEY` to any non-empty value.
- Set `ANTHROPIC_MODEL` to a **free model** to avoid paid usage.

---

## Running the proxy

```
npm run start
```

---

## Testing

### cURL example

```
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_incoming_proxy_key" \
  -d '{
    "model": "minimax/minimax-m2.5:free",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

If `INCOMING_API_KEY` is not set, omit the `Authorization` header.

### Claude Code example

```
claude -p "Hello from Kilo"
```

---

## How it works

1. Claude Code sends an Anthropic-style `/v1/messages` request to the proxy.
2. The proxy converts the payload to OpenAI-style and forwards it to Kilo Gateway.
3. The proxy converts Kilo responses back to Anthropic format for Claude Code.

---

## License

MIT
