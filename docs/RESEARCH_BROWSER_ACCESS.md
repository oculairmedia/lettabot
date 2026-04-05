# Research: Browser Access for Meridian

**Status:** Research  
**Date:** 2026-03-30  
**Goal:** Give Meridian visual browser access + devtools for frontend design and debugging

---

## Options Evaluated

### 1. Chrome DevTools MCP (Google Official)
- **What:** MCP server from Google's Chrome DevTools team, bridges AI agents to Chrome via CDP + Puppeteer
- **Tools:** 26 tools across 6 categories — navigation, screenshots, DOM snapshots, console logs, network inspection, performance tracing, input automation, viewport emulation
- **Setup:** `npx chrome-devtools-mcp@latest` — needs Node 20.19+ and Chrome stable
- **Pros:**
  - Official Google project, actively maintained
  - Deep debugging: console errors, network requests, CSS computed styles, Core Web Vitals
  - `take_screenshot` for visual + `take_snapshot` for DOM/CSS analysis
  - Performance profiling (LCP, CLS, INP)
  - CPU/network throttling emulation
- **Cons:**
  - Needs a running Chrome instance (headless or headed)
  - Security: exposes browser content to AI — use `--isolated` flag for temp profiles
- **Best for:** Deep debugging, performance analysis, devtools-level inspection

### 2. Playwright MCP (Microsoft Official)
- **What:** Microsoft's MCP server using accessibility tree snapshots instead of screenshots
- **Tools:** 70+ tools across 7 categories — navigation, tab mgmt, vision mode, PDF gen, testing/assertions, tracing/devtools, storage
- **Setup:** Standard MCP config, official Docker image available
- **Pros:**
  - Accessibility tree approach is 10-100x more efficient than screenshots (2-5KB vs 500KB-2MB)
  - Deterministic element refs (`click ref=42`) — precise and token-efficient
  - Hybrid `--vision auto` mode for canvas/WebGL elements
  - Self-healing capabilities
  - Broader browser engine support (Chromium, Firefox, WebKit)
  - 250K+ weekly installs, huge community
- **Cons:**
  - Accessibility tree may miss Shadow DOM elements
  - Less deep on Chrome-specific devtools features
- **Best for:** General browser automation, testing, token-efficient interaction

### 3. Steel Browser (Self-Hosted, LLM-Optimized)
- **What:** Open-source headless browser API built specifically for AI agents. Self-hosted Browserbase alternative.
- **Repo:** `steel-dev/steel-browser` (6,400+ GitHub stars)
- **Setup:** `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser-api:latest`
- **Pros:**
  - Purpose-built for AI agents — not a general virtual desktop repurposed
  - Full Puppeteer + CDP access via API
  - Session management with persistent cookies/storage (up to 24hr sessions)
  - Anti-detection: proxy support, browser fingerprinting, stealth mode
  - Auto CAPTCHA solving
  - Session recording for debugging
  - MCP server available (`steel-dev/steel-mcp-server`) — bridges directly to LLMs
  - Completely self-hosted, no subscriptions needed
  - SDKs for Python and Node.js
- **Cons:**
  - Newer project, less battle-tested than Playwright
  - No built-in visual streaming (it's API-first, not VNC/WebRTC)
- **Best for:** Self-hosted LLM browser infra — the "Neko for LLMs" Emmanuel asked for

### 4. browser-use/web-ui (AI Agent Browser with Visual UI)
- **What:** Open-source AI agent that runs in-browser with Gradio web UI. Hybrid DOM + Vision approach.
- **Repo:** `browser-use/web-ui` (78K+ GitHub stars for core lib)
- **Setup:** `docker compose up --build`, access WebUI + VNC viewer
- **Pros:**
  - Hybrid DOM + Vision — reads code AND takes screenshots, identifies elements visually
  - Persistent browser sessions between AI tasks
  - Supports multiple LLMs (OpenAI, Anthropic, Gemini, DeepSeek, Ollama)
  - VNC viewer for watching browser interactions live
  - MCP support for external tool connections
  - Multi-tab workflow management
  - 89.1% WebVoyager benchmark
- **Cons:**
  - Designed as its own agent loop — may need adaptation to work as a tool for Meridian
  - Gradio UI adds overhead
- **Best for:** When you want visual observation of browser actions + AI autonomy

### 5. Skyvern (Vision-First Browser Automation)
- **What:** Uses computer vision + LLMs to automate browser tasks from natural language
- **Pros:**
  - Identifies elements visually, not via DOM selectors — resilient to layout changes
  - Natural language task descriptions
  - Open-source + cloud options
- **Cons:**
  - Vision approach is 10-20x more expensive than DOM parsing
  - Higher latency
- **Best for:** Dynamic sites where DOM structure is unreliable

### 6. Neko (Self-Hosted Virtual Browser)
- **What:** Docker-based virtual browser with WebRTC streaming
- **Pros:**
  - Full visual browser experience
  - Multi-browser support (Chrome, Firefox, Brave, Edge, Tor)
  - Supports Playwright/Puppeteer alongside visual access
- **Cons:**
  - Not optimized for LLM interaction — it's a virtual desktop, not an API
  - Heavier resource footprint
  - Requires WebRTC/noVNC setup
- **Best for:** Human-facing virtual browser, not ideal for LLM-native workflows

---

## Recommendation (Updated)

Given the requirement for something "like Neko but optimized for LLMs":

**Top Pick: Steel Browser + Chrome DevTools MCP**
- Steel provides the self-hosted browser infra purpose-built for AI agents
- Chrome DevTools MCP provides the deep debugging tools (console, network, DOM, perf)
- Together they give: persistent sessions, screenshots, devtools, anti-detection, all self-hosted
- Steel's MCP server means I can interact with it natively

**Complement: Playwright MCP**
- Add for token-efficient accessibility tree interactions and testing workflows

**Skip:** Neko (not LLM-optimized), Browserbase (cloud), Skyvern (too expensive for routine use)

---

## Implementation Plan

1. Deploy Steel Browser via Docker on the server
2. Configure Steel MCP server to connect Meridian to Steel
3. Add Chrome DevTools MCP for deep debugging alongside Steel
4. Test: navigate to a local dev server, take screenshot, inspect console, check network
5. Add Playwright MCP as secondary tool for efficient automation
6. Create a skill (`/browser`) for common browser workflows
