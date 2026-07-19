/**
 * SSEWriter
 *
 * Writes Server-Sent Events to an Express response. Handles the SSE wire
 * format, headers, flushing, and graceful error events. The writer is
 * transport-agnostic — it does not know about providers or models, only SSE
 * events. This keeps it reusable by any streaming endpoint.
 *
 * SSE wire format:
 *   event: <name>\n
 *   data: <payload>\n
 *   \n
 *
 * For OpenAI-compatible streaming, most events are:
 *   data: {"json":"payload"}\n\n
 * terminated by:
 *   data: [DONE]\n\n
 */
class SSEWriter {
  /**
   * @param {object} res - Express response object
   * @param {object} [opts]
   * @param {boolean} [opts.flushAfterWrite=true]
   */
  constructor(res, opts = {}) {
    this.res = res;
    this.flushAfterWrite = opts.flushAfterWrite !== false;
    this.bytesWritten = 0;
    this.headersSent = false;
  }

  /**
   * Write SSE headers to the response. Must be called before any event.
   */
  writeHeaders() {
    if (this.headersSent) return;
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.headersSent = true;
  }

  /**
   * Write a raw SSE event with optional event name and data.
   * @param {object} event - { data: string, event?: string, id?: string }
   */
  writeEvent(event) {
    if (!this.headersSent) this.writeHeaders();
    let chunk = '';
    if (event.event) chunk += `event: ${event.event}\n`;
    if (event.id) chunk += `id: ${event.id}\n`;
    if (event.data !== undefined && event.data !== null) {
      chunk += `data: ${event.data}\n`;
    }
    chunk += '\n';
    this._writeRaw(chunk);
  }

  /**
   * Write a data-only event (most common OpenAI SSE shape).
   * @param {string} data
   */
  writeData(data) {
    this.writeEvent({ data });
  }

  /**
   * Write the [DONE] terminator.
   */
  writeDone() {
    this.writeData('[DONE]');
  }

  /**
   * Write an OpenAI-compatible error event, then end the response.
   * @param {object} error - { message, type, code, param }
   */
  writeError(error) {
    this.writeData(JSON.stringify({ error }));
  }

  /**
   * End the response stream.
   */
  end() {
    if (!this.res.writableEnded) {
      this.res.end();
    }
  }

  /**
   * Write a raw string to the response and flush if possible.
   * @param {string} chunk
   * @private
   */
  _writeRaw(chunk) {
    const ok = this.res.write(chunk);
    this.bytesWritten += Buffer.byteLength(chunk, 'utf8');
    if (this.flushAfterWrite && typeof this.res.flush === 'function') {
      this.res.flush();
    }
    return ok;
  }
}

module.exports = SSEWriter;
