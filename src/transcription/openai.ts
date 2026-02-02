/**
 * OpenAI Whisper transcription service
 */

import OpenAI from 'openai';
import { loadConfig } from '../config/index.js';

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    const config = loadConfig();
    // Config takes priority, then env var
    const apiKey = config.transcription?.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key required for transcription. Set in config (transcription.apiKey) or OPENAI_API_KEY env var.');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function getModel(): string {
  const config = loadConfig();
  return config.transcription?.model || process.env.TRANSCRIPTION_MODEL || 'whisper-1';
}

/**
 * Transcribe audio using OpenAI Whisper API
 * 
 * @param audioBuffer - The audio data as a Buffer
 * @param filename - Filename with extension (e.g., 'voice.ogg')
 * @returns The transcribed text
 */
export async function transcribeAudio(audioBuffer: Buffer, filename: string = 'audio.ogg'): Promise<string> {
  const client = getClient();
  
  // Normalize filename for Whisper API (e.g., .aac -> .m4a)
  const normalizedFilename = normalizeFilename(filename);
  
  // Create a File object from the buffer
  // OpenAI SDK expects a File-like object
  // Convert Buffer to Uint8Array to satisfy BlobPart type
  const file = new File([new Uint8Array(audioBuffer)], normalizedFilename, { 
    type: getMimeType(normalizedFilename) 
  });
  
  const response = await client.audio.transcriptions.create({
    file,
    model: getModel(),
  });
  
  return response.text;
}

/**
 * Supported formats for OpenAI Whisper API
 */
const SUPPORTED_FORMATS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];

/**
 * Get MIME type from filename extension
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    'ogg': 'audio/ogg',
    'oga': 'audio/ogg',
    'mp3': 'audio/mpeg',
    'mp4': 'audio/mp4',
    'm4a': 'audio/mp4',
    'aac': 'audio/mp4', // AAC is the codec in m4a
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'webm': 'audio/webm',
    'mpeg': 'audio/mpeg',
    'mpga': 'audio/mpeg',
  };
  return mimeTypes[ext || ''] || 'audio/ogg';
}

/**
 * Normalize filename for Whisper API
 * Converts unsupported extensions to supported equivalents
 */
function normalizeFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  // AAC is just the codec - Whisper accepts it as m4a
  if (ext === 'aac') {
    return filename.replace(/\.aac$/i, '.m4a');
  }
  
  // Check if already supported
  if (ext && SUPPORTED_FORMATS.includes(ext)) {
    return filename;
  }
  
  // Default fallback - try as ogg
  console.warn(`[Transcription] Unknown format .${ext}, trying as .ogg`);
  return filename.replace(/\.[^.]+$/, '.ogg');
}
