# AI Gateway

A professional API Gateway for AI services built with Node.js, Express, and vanilla JavaScript. Provides a unified endpoint to interact with multiple AI models, with built‑in security, logging, and graceful shutdown handling.

## Features

- **Root API Info** – GET `/` returns service name, version, description, default model, and available endpoints.
- **Health Check** – GET `/health` returns status, server uptime, version, and timestamp.
- **Model Listing** – GET `/v1/models` returns a list of available models (configurable via `.env`), OpenAI‑compatible format.
- **Application Info** – GET `/v1/info` returns current app configuration (name, version, description, default model).
- **AI Generation** – POST `/api/v1/generate` accepts a prompt (and optional model) and returns a generated text from the configured AI provider (currently integrated with DeepSeek via OpenAI‑compatible API).
- **Security** – Uses `helmet` for HTTP headers, `cors` for cross‑origin support, and input validation.
- **Logging** – Uses `morgan` with a format that adapts to the environment (`combined` for production, `dev` for development).
- **Error Handling** – Custom `AppError` class for operational errors; uncaught exceptions and unhandled rejections are logged and shut down gracefully.
- **Graceful Shutdown** – Listens for `SIGTERM` and `SIGINT` signals, closes the server cleanly.
- **Configuration** – All settings (port, environment, version, AI API URL, API key, default model, models list) are externalized to a `.env` file.
- **Environment Validation** – The server aborts at startup if `AI_API_KEY` is not set.
- **Async Error Handling** – Route handlers are wrapped with `asyncHandler` to forward errors to the global handler automatically.

## Prerequisites

- [Node.js](https://nodejs.org) v14 or later
- npm (comes with Node.js)
- An API key for a DeepSeek‑compatible AI provider (or OpenAI‑style provider).

## Installation

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd ai-gateway
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy the example environment file and adjust as needed:
   ```bash
   cp .env.example .env
   ```

## Configuration

Edit the `.env` file with your preferred settings:

