/**
 * StreamParser
 *
 * Parses raw SSE (Server-Sent Events) byte chunks from a provider into
 * discrete SSE events. Handles partial events that span multiple chunks by
 * buffering until a complete event (terminated by a blank line) is received.
 *
 * SSE wire format:
 *   data: {"json":"payload"}\n\n
 *   data: [DONE]\n\n
 *
 * The parser is a transform stream: write raw bytes/strings in, emit
 * parsed event objects out via the 'event' callback.
 */
const { Transform } = require('stream');

class StreamParser extends Transform {
  constructor(opts = {}) {
    super({ ...opts, objectMode: true });
    this._buffer = '';
  }

  _transform(chunk, encoding, callback) {
    this._buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);

    // SSE events are separated by a blank line. Handle both \n\n and \r\n\r\n.
    let separatorIndex;
    while (
      (separatorIndex = this._findEventBoundary(this._buffer)) !== -1
    ) {
      const rawEvent = this._buffer.slice(0, separatorIndex);
      // skip the separator (2 for \n\n, 4 for \r\n\r\n)
      const sepLen = this._buffer[separatorIndex + 1] === '\n' ? 2 : 4;
      this._buffer = this._buffer.slice(separatorIndex + sepLen);

      const parsed = this._parseEvent(rawEvent);
      if (parsed) this.push(parsed);
    }
    callback();
  }

  _flush(callback) {
    if (this._buffer.trim()) {
      const parsed = this._parseEvent(this._buffer);
      if (parsed) this.push(parsed);
      this._buffer = '';
    }
    callback();
  }

  /**
   * Find the index of the next event boundary (\n\n or \r\n\r\n).
   * @param {string} buf
   * @returns {number} index or -1
   * @private
   */
  _findEventBoundary(buf) {
    const idx = buf.indexOf('\n\n');
    if (idx !== -1) return idx;
    const idx2 = buf.indexOf('\r\n\r\n');
    return idx2;
  }

  /**
   * Parse a single raw SSE event block into a structured event object.
   * @param {string} raw
   * @returns {object|null} { data: string, event?: string, id?: string }
   * @private
   */
  _parseEvent(raw) {
    const lines = raw.split(/\r?\n/);
    const event = {};
    let dataLines = [];

    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      } else if (line.startsWith('event:')) {
        event.event = line.slice(6).replace(/^ /, '');
      } else if (line.startsWith('id:')) {
        event.id = line.slice(3).replace(/^ /, '');
      } else if (line.startsWith(':') || line.trim() === '') {
        // comment or blank line — ignore
      }
    }

    if (dataLines.length === 0) return null;
    event.data = dataLines.join('\n');
    return event;
  }

  /**
   * Check if a parsed event is the OpenAI stream terminator [DONE].
   * @param {object} event
   * @returns {boolean}
   */
  static isDone(event) {
    return event && event.data === '[DONE]';
  }
}

module.exports = StreamParser;
