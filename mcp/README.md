# Lotus Network MCP

Five pay-per-call tools on Base, exposed over the Model Context Protocol. The server
holds a wallet and completes the x402 V2 handshake for each call, so the model just
calls a tool and gets a result.

| Tool | Cost | What it does |
|---|---|---|
| `generate_image` | $0.05 | FLUX text-to-image, returns the image and a permanent URL |
| `pdf_to_markdown` | $0.005 | Extracts a PDF's text layer as clean Markdown |
| `gas_preflight` | $0.002 | Base gas conditions plus an 80% forecast range |
| `gas_decision` | $0.003 | Journals an execute/wait decision, returns a `decision_id` |
| `gas_audit` | $0.002 | Verifies a `decision_id` against what the chain actually did |
| `lotus_wallet_status` | free | Wallet address, session spend, remaining budget |

## This server spends real money

It signs USDC transfers on Base without asking you first. A model decides when to
call the tools; the caps below decide how much that can cost.

- `MAX_CALL_USD` — hard ceiling on any single payment. Default **$0.10**.
- `MAX_SESSION_USD` — total before the process must be restarted. Default **$1.00**.

Use a dedicated wallet funded with a few dollars. Do not point this at a wallet
holding anything you would miss.

## Install

```bash
npm install
```

Fund a wallet with **native USDC on Base** (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).
Bridged USDbC will not work.

## Claude Desktop

Edit `claude_desktop_config.json`:

- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "lotus-network": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.js"],
      "env": {
        "WALLET_PRIVATE_KEY": "0xyour_private_key",
        "MAX_CALL_USD": "0.10",
        "MAX_SESSION_USD": "1.00"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the connectors icon.

## Cursor

Add to `.cursor/mcp.json` in your project, or the global equivalent:

```json
{
  "mcpServers": {
    "lotus-network": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.js"],
      "env": { "WALLET_PRIVATE_KEY": "0xyour_private_key" }
    }
  }
}
```

## Environment

| Variable | Default | Notes |
|---|---|---|
| `WALLET_PRIVATE_KEY` | — | Required. Signs the USDC authorizations. |
| `LOTUS_API_URL` | `https://lotusnetworkapi.com` | Point elsewhere to test against another host. |
| `MAX_CALL_USD` | `0.10` | Per-call ceiling. |
| `MAX_SESSION_USD` | `1.00` | Session ceiling. |

## Checking it works

```bash
WALLET_PRIVATE_KEY=0x... node index.js
```

It should print the wallet address, target, and caps to stderr, then wait on stdio.
That is correct — it speaks JSON-RPC, not a shell. Nothing is written to stdout
except protocol traffic.

Once connected, ask the host to run `lotus_wallet_status` first. It is free and
confirms the wallet and budget before anything spends.

## The gas loop

`gas_preflight` → `gas_decision` → wait for the horizon → `gas_audit`

The audit is the point: it reports whether the forecast interval actually contained
the observed base fee, and links to the block on BaseScan so the claim can be checked
independently. Calibration is measured, not asserted.

## Troubleshooting

**"Expected a 402 challenge"** — the API is not gating that route, or the URL is wrong.

**"above the per-call cap"** — raise `MAX_CALL_USD`, or use a cheaper tool.

**Payment fails verification** — the wallet is probably empty or holds bridged USDbC
rather than native USDC. Check on BaseScan.

**Tools do not appear** — the host could not spawn the process. Use an absolute path
in `args`, confirm Node 20+, and check the host's MCP logs.
