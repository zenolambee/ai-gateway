# AI Gateway

A professional API Gateway for AI services built with Node.js, Express, and vanilla JavaScript. Provides a unified endpoint to interact with multiple AI models, with built‑in security, logging, and graceful shutdown handling.

## Features

- **Health Check** – GET `/health` returns status, version, and timestamp.
- **Model Listing** – GET `/v1/models` returns a list of available models (configurable via `.env`).
- **AI Generation** – POST `/api/v1/generate` accepts a prompt and returns a generated result (currently echoes the prompt; ready for integration with real AI providers).
- **Security** – Uses `helmet` for HTTP headers, `cors` for cross‑origin support, and input validation.
- **Logging** – Uses `morgan` with a format that adapts to the environment (`combined` for production, `dev` for development).
- **Error Handling** – Custom `AppError` class for operational errors; uncaught exceptions and unhandled rejections are logged and shut down gracefully.
- **Graceful Shutdown** – Listens for `SIGTERM` and `SIGINT` signals, closes the server cleanly.
- **Configuration** – All settings (port, environment, version, models list) are externalized to a `.env` file.

## Prerequisites

- [Node.js](https://nodejs.org) v14 or later
- npm (comes with Node.js)

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

